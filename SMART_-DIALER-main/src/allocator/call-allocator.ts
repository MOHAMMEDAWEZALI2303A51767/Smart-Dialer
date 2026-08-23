// ─── Call Allocator ─────────────────────────────────────────────────────────
import { AgentStateMachine } from '../state-machine/agent-state-machine.js';
import { CallStateMachine } from '../state-machine/call-state-machine.js';
import { AgentState, AgentEvent } from '../types/agent.js';
import { CallState, CallEvent, CallDisposition } from '../types/call.js';
import { ITelecomProvider } from '../types/provider.js';
import { SafetyController } from '../safety/safety-controller.js';
import { SafetyDecision, DialProposal, SafetyVerdict } from '../types/call.js';
import { StatsCollector } from '../pacing/stats-collector.js';
import { CircuitBreaker } from '../safety/circuit-breaker.js';
import { ProgressiveEngine } from '../pacing/progressive-engine.js';
import { PredictiveEngine } from '../pacing/predictive-engine.js';
import { BorrowerQueue } from './borrower-queue.js';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

/**
 * CallAllocator orchestrates the full dialing lifecycle:
 *
 *   Pacing Engine → Safety Controller → (this) Allocator → Telecom Provider
 *
 * Progressive: every outbound call is bound to a reserved agent first.
 * Predictive: extra approved dials may be speculative (no agent yet);
 *             on ANSWER we bind the first free agent, else ABANDONED.
 */
export class CallAllocator extends EventEmitter {
  private workerId: string;
  private desiredPacingMode: 'PROGRESSIVE' | 'PREDICTIVE' = 'PROGRESSIVE';
  private forcedProgressiveUntil: number = 0;
  private fallbackCooldownMs: number = 10_000;
  private dialCycleInterval: NodeJS.Timeout | null = null;
  private dialCycleIntervalMs: number = 2000;
  private running: boolean = false;
  private wrapUpDurationMs: number = 1000;

  /** Mapping: callId -> agentId (null for speculative predictive dials) */
  private callAgentMapping: Map<string, string | null> = new Map();
  private callBorrowerMapping: Map<string, string> = new Map();
  /** Dedup: never initiate the same callId twice */
  private initiatedCallIds: Set<string> = new Set();

  constructor(
    private agentSM: AgentStateMachine,
    private callSM: CallStateMachine,
    private provider: ITelecomProvider,
    private safetyController: SafetyController,
    private statsCollector: StatsCollector,
    private circuitBreaker: CircuitBreaker,
    private progressiveEngine: ProgressiveEngine,
    private predictiveEngine: PredictiveEngine,
    private borrowerQueue: BorrowerQueue = new BorrowerQueue(),
    workerId?: string
  ) {
    super();
    this.workerId = workerId || `worker-${uuidv4().slice(0, 8)}`;
    this.provider.onEvent(this.handleProviderEvent.bind(this));

    this.agentSM.on('agent:transition', (evt: {
      agentId: string;
      previousState: AgentState;
      newState: AgentState;
      event: AgentEvent;
    }) => {
      if (
        evt.event === AgentEvent.LOGOUT &&
        (evt.previousState === AgentState.RESERVED || evt.previousState === AgentState.DIALING)
      ) {
        this.handleAgentDisappeared(evt.agentId);
      }
    });
  }

  start(intervalMs?: number): void {
    if (this.running) return;
    this.running = true;
    if (intervalMs) this.dialCycleIntervalMs = intervalMs;

    this.dialCycleInterval = setInterval(() => {
      this.executeDiaLCycle().catch((err) => {
        this.emit('error', { error: err, context: 'dial-cycle' });
      });
    }, this.dialCycleIntervalMs);

    this.emit('allocator:started', { workerId: this.workerId, pacingMode: this.getPacingMode() });
  }

  stop(): void {
    if (this.dialCycleInterval) {
      clearInterval(this.dialCycleInterval);
      this.dialCycleInterval = null;
    }
    this.running = false;
    this.emit('allocator:stopped', { workerId: this.workerId });
  }

  setPacingMode(mode: 'PROGRESSIVE' | 'PREDICTIVE'): void {
    this.desiredPacingMode = mode;
    this.emit('allocator:pacing-changed', { mode });
  }

  setWrapUpDurationMs(ms: number): void {
    this.wrapUpDurationMs = ms;
  }

  getEffectivePacingMode(): 'PROGRESSIVE' | 'PREDICTIVE' {
    if (Date.now() < this.forcedProgressiveUntil) return 'PROGRESSIVE';
    return this.desiredPacingMode;
  }

  async executeDiaLCycle(): Promise<{
    proposal: DialProposal;
    verdict: SafetyVerdict;
    dialsAttempted: number;
    dialsSucceeded: number;
  }> {
    const effectiveMode = this.getEffectivePacingMode();
    const proposal =
      effectiveMode === 'PREDICTIVE'
        ? this.predictiveEngine.propose()
        : this.progressiveEngine.propose();

    const verdict = this.safetyController.evaluate(proposal);

    if (verdict.decision === SafetyDecision.FORCE_PROGRESSIVE_FALLBACK) {
      this.forcedProgressiveUntil = Date.now() + this.fallbackCooldownMs;
      this.emit('allocator:forced-progressive', { reason: verdict.reason });
    }

    let dialsAttempted = 0;
    let dialsSucceeded = 0;
    const approvedCount = verdict.approvedDials;
    const allowSpeculative = effectiveMode === 'PREDICTIVE' &&
      verdict.decision !== SafetyDecision.FORCE_PROGRESSIVE_FALLBACK;

    if (approvedCount > 0) {
      for (let i = 0; i < approvedCount; i++) {
        const placed = this.placeOneDial(allowSpeculative);
        if (!placed.attempted) break;
        dialsAttempted++;
        if (placed.succeeded) dialsSucceeded++;
      }
    }

    this.emit('allocator:cycle-complete', {
      proposal,
      verdict,
      dialsAttempted,
      dialsSucceeded,
      effectiveMode,
    });

    return { proposal, verdict, dialsAttempted, dialsSucceeded };
  }

  private placeOneDial(allowSpeculative: boolean): { attempted: boolean; succeeded: boolean } {
    const borrower = this.borrowerQueue.claimNext(this.workerId);
    if (!borrower) {
      return { attempted: false, succeeded: false };
    }

    const agent = this.agentSM.reserveAvailableAgent(this.workerId);

    if (!agent && !allowSpeculative) {
      this.borrowerQueue.releaseForRetry(borrower.id);
      return { attempted: false, succeeded: false };
    }

    const call = this.callSM.createCall(borrower.id, borrower.phoneNumber, this.provider.providerId);
    this.callBorrowerMapping.set(call.id, borrower.id);
    this.callSM.transition(call.id, CallEvent.RESERVE, { agentId: agent?.id });

    if (agent) {
      this.callAgentMapping.set(call.id, agent.id);
      try {
        this.agentSM.transition(agent.id, AgentEvent.DIAL_STARTED, agent.version, {
          callId: call.id,
        });
      } catch {
        try { this.agentSM.forceRelease(agent.id); } catch {}
        this.callAgentMapping.delete(call.id);
        this.callBorrowerMapping.delete(call.id);
        this.borrowerQueue.releaseForRetry(borrower.id);
        this.callSM.transition(call.id, CallEvent.CANCEL);
        return { attempted: true, succeeded: false };
      }
    } else {
      this.callAgentMapping.set(call.id, null);
    }

    if (this.initiatedCallIds.has(call.id)) {
      this.borrowerQueue.releaseForRetry(borrower.id);
      return { attempted: true, succeeded: false };
    }
    this.initiatedCallIds.add(call.id);

    this.provider.initiateCall(call.id, borrower.phoneNumber).then((result) => {
      this.circuitBreaker.recordOutcome(result.success, result.latencyMs);

      if (result.success) {
        this.callSM.transition(call.id, CallEvent.INITIATE);
        this.borrowerQueue.markInCall(borrower.id);
      } else {
        this.callSM.transition(call.id, CallEvent.FAIL, { failureReason: result.error });
        if (agent) this.releaseAgentImmediately(agent.id);
        this.callAgentMapping.delete(call.id);
        this.callBorrowerMapping.delete(call.id);
        this.borrowerQueue.releaseForRetry(borrower.id);
      }
    }).catch((err) => {
      this.circuitBreaker.recordOutcome(false, 0);
      this.callSM.transition(call.id, CallEvent.FAIL, {
        failureReason: `Provider error: ${err}`,
      });
      if (agent) this.releaseAgentImmediately(agent.id);
      this.callAgentMapping.delete(call.id);
      this.callBorrowerMapping.delete(call.id);
      this.borrowerQueue.releaseForRetry(borrower.id);
    });

    return { attempted: true, succeeded: true };
  }

  /**
   * Agent logged out (or dropped) while a call was still being set up.
   * Cancel the in-flight call and retry the borrower later.
   */
  handleAgentDisappeared(agentId: string): void {
    let callId: string | null = null;
    for (const [cid, aid] of this.callAgentMapping.entries()) {
      if (aid === agentId) {
        callId = cid;
        break;
      }
    }
    if (!callId) return;

    const call = this.callSM.getCall(callId);
    if (!call || call.state === CallState.CONNECTED) return;

    this.provider.cancelCall(callId).catch(() => {});
    this.callSM.transition(callId, CallEvent.CANCEL, {
      failureReason: `Agent ${agentId} disappeared during call setup`,
    });
    this.releaseBorrowerForCall(callId, false);
    this.callAgentMapping.delete(callId);
    this.emit('allocator:agent-disappeared', { callId, agentId });
  }

  private handleProviderEvent(event: {
    eventId: string;
    callId: string;
    eventType: string;
    timestamp: number;
    providerId: string;
  }): void {
    const callEvent = this.mapProviderEventType(event.eventType);
    if (!callEvent) return;

    const result = this.callSM.transition(event.callId, callEvent, {
      eventId: event.eventId,
      timestamp: event.timestamp,
    });

    if (result.skipped) return;

    const call = result.call;
    if (!call) return;

    switch (callEvent) {
      case CallEvent.ANSWER:
        this.handleCallAnswered(call.id);
        break;
      case CallEvent.COMPLETE:
      case CallEvent.NO_ANSWER:
        this.handleCallCompleted(call.id, callEvent === CallEvent.NO_ANSWER);
        break;
      case CallEvent.FAIL:
        this.handleCallFailed(call.id);
        break;
      case CallEvent.CANCEL:
        this.handleCallCancelled(call.id);
        break;
    }
  }

  private handleCallAnswered(callId: string): void {
    let agentId = this.callAgentMapping.get(callId) ?? null;

    if (!agentId) {
      const reserved = this.agentSM.reserveAvailableAgent(this.workerId);
      if (!reserved) {
        this.callSM.markAbandoned(callId);
        this.provider.cancelCall(callId).catch(() => {});
        this.releaseBorrowerForCall(callId, false);
        this.emit('allocator:abandoned-call', { callId });
        return;
      }
      agentId = reserved.id;
      this.callAgentMapping.set(callId, agentId);
      try {
        this.agentSM.transition(agentId, AgentEvent.DIAL_STARTED, reserved.version, { callId });
      } catch {
        this.callSM.markAbandoned(callId);
        this.releaseBorrowerForCall(callId, false);
        return;
      }
    }

    const agent = this.agentSM.getAgent(agentId);
    if (!agent || agent.state === AgentState.OFFLINE) {
      this.callSM.markAbandoned(callId);
      this.releaseBorrowerForCall(callId, false);
      return;
    }

    try {
      if (agent.state === AgentState.DIALING || agent.state === AgentState.RESERVED) {
        this.agentSM.transition(agentId, AgentEvent.CALL_ANSWERED, agent.version, { callId });
      }
      this.callSM.transition(callId, CallEvent.CONNECT, { agentId });
      this.emit('allocator:call-connected', { callId, agentId });
    } catch {
      this.callSM.markAbandoned(callId);
      this.releaseBorrowerForCall(callId, false);
    }
  }

  private handleCallCompleted(callId: string, noAnswer: boolean): void {
    const agentId = this.callAgentMapping.get(callId);
    const call = this.callSM.getCall(callId);

    if (call) {
      const ringDuration = call.ringDurationMs || 0;
      const talkDuration = call.talkDurationMs || 0;
      const wasAnswered = !noAnswer && (call.answeredAt !== null || call.connectedAt !== null);

      this.statsCollector.recordCallOutcome(
        wasAnswered,
        ringDuration,
        talkDuration,
        this.wrapUpDurationMs
      );
    }

    if (typeof agentId === 'string') {
      const agent = this.agentSM.getAgent(agentId);
      if (agent) {
        if (noAnswer || agent.state === AgentState.DIALING) {
          this.releaseAgentImmediately(agentId);
        } else if (agent.state === AgentState.CONNECTED) {
          try {
            this.agentSM.transition(agentId, AgentEvent.CALL_ENDED, agent.version);
            setTimeout(() => {
              const updated = this.agentSM.getAgent(agentId);
              if (updated && updated.state === AgentState.WRAP_UP) {
                try {
                  this.agentSM.transition(agentId, AgentEvent.WRAP_UP_COMPLETE, updated.version);
                } catch {
                  this.agentSM.forceRelease(agentId);
                }
              }
            }, this.wrapUpDurationMs);
          } catch {
            this.agentSM.forceRelease(agentId);
          }
        }
      }
      this.callAgentMapping.delete(callId);
    } else {
      this.callAgentMapping.delete(callId);
    }

    this.releaseBorrowerForCall(callId, !noAnswer && call?.disposition !== CallDisposition.ABANDONED);
    this.emit('allocator:call-completed', { callId, agentId, noAnswer });
  }

  private handleCallFailed(callId: string): void {
    const agentId = this.callAgentMapping.get(callId);
    if (typeof agentId === 'string') {
      this.releaseAgentImmediately(agentId);
      this.callAgentMapping.delete(callId);
    } else {
      this.callAgentMapping.delete(callId);
    }
    this.statsCollector.recordCallOutcome(false, 0);
    this.releaseBorrowerForCall(callId, false);
  }

  private handleCallCancelled(callId: string): void {
    const agentId = this.callAgentMapping.get(callId);
    if (typeof agentId === 'string') {
      this.releaseAgentImmediately(agentId);
      this.callAgentMapping.delete(callId);
    } else {
      this.callAgentMapping.delete(callId);
    }
    this.releaseBorrowerForCall(callId, false);
  }

  private releaseBorrowerForCall(callId: string, completedSuccessfully: boolean): void {
    const borrowerId = this.callBorrowerMapping.get(callId);
    if (!borrowerId) return;
    if (completedSuccessfully) {
      this.borrowerQueue.complete(borrowerId);
    } else {
      this.borrowerQueue.releaseForRetry(borrowerId);
    }
    this.callBorrowerMapping.delete(callId);
  }

  private releaseAgentImmediately(agentId: string): void {
    const agent = this.agentSM.getAgent(agentId);
    if (!agent) return;

    if (
      agent.state === AgentState.RESERVED ||
      agent.state === AgentState.DIALING ||
      agent.state === AgentState.WRAP_UP
    ) {
      try {
        this.agentSM.transition(agentId, AgentEvent.RELEASE, agent.version);
      } catch {
        this.agentSM.forceRelease(agentId);
      }
    }
  }

  private mapProviderEventType(eventType: string): CallEvent | null {
    const mapping: Record<string, CallEvent> = {
      RING: CallEvent.RING,
      ANSWER: CallEvent.ANSWER,
      COMPLETE: CallEvent.COMPLETE,
      NO_ANSWER: CallEvent.NO_ANSWER,
      FAIL: CallEvent.FAIL,
      CANCEL: CallEvent.CANCEL,
    };
    return mapping[eventType] || null;
  }

  isRunning(): boolean { return this.running; }
  getWorkerId(): string { return this.workerId; }
  getPacingMode(): string { return this.getEffectivePacingMode(); }
  getCallAgentMappingSize(): number { return this.callAgentMapping.size; }
  getBorrowerQueue(): BorrowerQueue { return this.borrowerQueue; }
}
