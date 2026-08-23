// ─── Watchdog (Orphan & Lease Sweeper) ──────────────────────────────────────
import { AgentStateMachine } from '../state-machine/agent-state-machine.js';
import { CallStateMachine } from '../state-machine/call-state-machine.js';
import { AgentState, AgentEvent } from '../types/agent.js';
import { CallState, CallEvent, TERMINAL_CALL_STATES } from '../types/call.js';
import { BorrowerQueue } from './borrower-queue.js';
import { EventEmitter } from 'events';

/**
 * Watchdog runs periodically to detect and recover from:
 *
 * 1. EXPIRED AGENT RESERVATIONS
 *    If a worker crashes after reserving an agent but before initiating a call,
 *    the agent remains stuck in RESERVED state forever. The watchdog detects
 *    expired reservation leases and force-releases agents back to AVAILABLE.
 *
 * 2. ORPHANED CALLS
 *    Calls stuck in non-terminal states (INITIATED, RINGING) for too long
 *    without receiving provider events. These are force-completed with FAILED
 *    disposition.
 *
 * 3. AGENT-CALL MISMATCH
 *    Agents stuck in DIALING/CONNECTED state but whose associated call has
 *    already completed. These agents are force-released.
 */
export class Watchdog extends EventEmitter {
  private sweepInterval: NodeJS.Timeout | null = null;
  private sweepIntervalMs: number;
  /** Max time (ms) a call can sit in INITIATED/RINGING before being declared orphaned */
  private maxCallStalenessMs: number;
  /** Sweep statistics */
  private totalSweeps: number = 0;
  private totalAgentsReclaimed: number = 0;
  private totalCallsRecovered: number = 0;

  constructor(
    private agentSM: AgentStateMachine,
    private callSM: CallStateMachine,
    sweepIntervalMs: number = 10000,
    maxCallStalenessMs: number = 60000,
    private borrowerQueue?: BorrowerQueue
  ) {
    super();
    this.sweepIntervalMs = sweepIntervalMs;
    this.maxCallStalenessMs = maxCallStalenessMs;
  }

  /**
   * Start the watchdog sweep cycle.
   */
  start(): void {
    if (this.sweepInterval) return;

    this.sweepInterval = setInterval(() => {
      this.sweep();
    }, this.sweepIntervalMs);

    this.emit('watchdog:started');
  }

  /**
   * Stop the watchdog.
   */
  stop(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
    this.emit('watchdog:stopped');
  }

  /**
   * Execute one sweep cycle.
   */
  sweep(): { agentsReclaimed: number; callsRecovered: number } {
    this.totalSweeps++;
    let agentsReclaimed = 0;
    let callsRecovered = 0;

    // ── 1. Sweep expired agent reservations ──
    const expiredAgents = this.agentSM.getExpiredReservations();
    for (const agent of expiredAgents) {
      const result = this.agentSM.forceRelease(agent.id);
      if (result.success) {
        agentsReclaimed++;
        this.totalAgentsReclaimed++;
        this.emit('watchdog:agent-reclaimed', {
          agentId: agent.id,
          previousState: result.previousState,
          reason: 'Reservation lease expired',
        });
      }
    }

    // ── 2. Sweep orphaned calls ──
    const now = Date.now();
    const activeCalls = this.callSM.getActiveCalls();
    for (const call of activeCalls) {
      const staleness = now - (call.initiatedAt || call.createdAt);
      const isStale = staleness > this.maxCallStalenessMs;

      // Only recover INITIATED/RINGING calls that are stale
      if (
        isStale &&
        (call.state === CallState.INITIATED || call.state === CallState.RINGING)
      ) {
        this.callSM.transition(call.id, CallEvent.FAIL, {
          failureReason: `Watchdog: Call orphaned for ${Math.round(staleness / 1000)}s`,
        });
        this.borrowerQueue?.releaseForRetry(call.borrowerId);
        callsRecovered++;
        this.totalCallsRecovered++;
        this.emit('watchdog:call-recovered', {
          callId: call.id,
          stalenessMs: staleness,
        });
      }
    }

    // ── 2b. Worker crashed after ANSWERED, before CONNECT ──
    for (const call of this.callSM.getAnsweredUnconnectedCalls()) {
      if (!call.agentId) continue;
      const agent = this.agentSM.getAgent(call.agentId);
      if (!agent) continue;
      try {
        if (agent.state === AgentState.DIALING || agent.state === AgentState.RESERVED) {
          this.agentSM.transition(agent.id, AgentEvent.CALL_ANSWERED, agent.version, {
            callId: call.id,
          });
        }
        this.callSM.transition(call.id, CallEvent.CONNECT, { agentId: agent.id });
        this.borrowerQueue?.markInCall(call.borrowerId);
        callsRecovered++;
        this.totalCallsRecovered++;
        this.emit('watchdog:answered-connected', { callId: call.id, agentId: agent.id });
      } catch {
        // Leave for a later sweep
      }
    }

    // ── 3. Sweep agent-call mismatches ──
    const dialingAgents = this.agentSM.getAgentsByState(AgentState.DIALING);
    for (const agent of dialingAgents) {
      if (agent.currentCallId) {
        const call = this.callSM.getCall(agent.currentCallId);
        if (call && TERMINAL_CALL_STATES.has(call.state)) {
          // Call is done but agent is still DIALING — reclaim
          this.agentSM.forceRelease(agent.id);
          agentsReclaimed++;
          this.totalAgentsReclaimed++;
          this.emit('watchdog:agent-reclaimed', {
            agentId: agent.id,
            previousState: AgentState.DIALING,
            reason: `Call ${agent.currentCallId} already in terminal state ${call.state}`,
          });
        }
      }
    }

    if (agentsReclaimed > 0 || callsRecovered > 0) {
      this.emit('watchdog:sweep-findings', {
        sweepNumber: this.totalSweeps,
        agentsReclaimed,
        callsRecovered,
      });
    }

    return { agentsReclaimed, callsRecovered };
  }

  /**
   * Get watchdog statistics.
   */
  getStats() {
    return {
      totalSweeps: this.totalSweeps,
      totalAgentsReclaimed: this.totalAgentsReclaimed,
      totalCallsRecovered: this.totalCallsRecovered,
    };
  }

  reset(): void {
    this.stop();
    this.totalSweeps = 0;
    this.totalAgentsReclaimed = 0;
    this.totalCallsRecovered = 0;
    this.removeAllListeners();
  }
}
