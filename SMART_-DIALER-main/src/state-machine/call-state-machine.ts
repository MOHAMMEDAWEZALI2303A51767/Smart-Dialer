// ─── Call State Machine with Idempotency & Out-of-Order Handling ────────────
import {
  Call,
  CallState,
  CallEvent,
  CallDisposition,
  CALL_TRANSITIONS,
  TERMINAL_CALL_STATES,
  ProviderCallEvent,
  CallStats,
} from '../types/call.js';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

/**
 * CallStateMachine manages the lifecycle of all calls with:
 * - Directed Acyclic State Transition Matrix enforcement
 * - Event deduplication via eventId tracking
 * - Graceful out-of-order event reconciliation (skip-ahead to terminal states)
 * - Duplicate events result in safe no-ops
 */
export class CallStateMachine extends EventEmitter {
  private calls: Map<string, Call> = new Map();
  /** Global set of processed event IDs for deduplication */
  private processedEventIds: Set<string> = new Set();

  constructor() {
    super();
  }

  // ─── Call Creation ──────────────────────────────────────────────────────

  /**
   * Create a new call in QUEUED state.
   */
  createCall(borrowerId: string, borrowerPhone: string, providerId: string): Call {
    const call: Call = {
      id: uuidv4(),
      borrowerId,
      borrowerPhone,
      agentId: null,
      state: CallState.QUEUED,
      disposition: null,
      providerId,
      createdAt: Date.now(),
      initiatedAt: null,
      ringingAt: null,
      answeredAt: null,
      connectedAt: null,
      completedAt: null,
      ringDurationMs: null,
      talkDurationMs: null,
      totalDurationMs: null,
      processedEventIds: new Set(),
      failureReason: null,
    };
    this.calls.set(call.id, call);
    this.emit('call:created', call);
    return call;
  }

  // ─── State Transitions ─────────────────────────────────────────────────

  /**
   * Attempt to transition a call via the given event.
   *
   * Idempotency guarantee:
   *   - If eventId has already been processed → no-op, returns current state.
   *   - If event is valid from current state → transition.
   *   - If current state is terminal → no-op (log and ignore).
   *   - If event would be valid from a LATER state (out-of-order) → skip-ahead.
   */
  transition(
    callId: string,
    event: CallEvent,
    options: {
      eventId?: string;
      agentId?: string;
      disposition?: CallDisposition;
      failureReason?: string;
      timestamp?: number;
    } = {}
  ): { success: boolean; call: Call | null; skipped: boolean; reason?: string } {
    const call = this.calls.get(callId);
    if (!call) {
      return { success: false, call: null, skipped: false, reason: `Call ${callId} not found` };
    }

    const eventId = options.eventId || uuidv4();
    const now = options.timestamp || Date.now();

    // ── Deduplication: Check if event already processed ──
    if (call.processedEventIds.has(eventId) || this.processedEventIds.has(eventId)) {
      // Duplicate event — safe no-op
      return {
        success: true,
        call: { ...call, processedEventIds: new Set(call.processedEventIds) },
        skipped: true,
        reason: `Duplicate event ${eventId} — already processed`,
      };
    }

    // ── Terminal state: No further transitions ──
    if (TERMINAL_CALL_STATES.has(call.state)) {
      call.processedEventIds.add(eventId);
      this.processedEventIds.add(eventId);
      return {
        success: true,
        call: { ...call, processedEventIds: new Set(call.processedEventIds) },
        skipped: true,
        reason: `Call ${callId} already in terminal state ${call.state}`,
      };
    }

    // ── Validate transition ──
    const allowedTransitions = CALL_TRANSITIONS[call.state];
    const nextState = allowedTransitions[event];

    if (!nextState) {
      // Event not valid from current state — ignore gracefully
      call.processedEventIds.add(eventId);
      this.processedEventIds.add(eventId);
      return {
        success: false,
        call: { ...call, processedEventIds: new Set(call.processedEventIds) },
        skipped: true,
        reason: `Event ${event} not valid from state ${call.state}`,
      };
    }

    const previousState = call.state;

    // ── Apply transition ──
    call.state = nextState;
    call.processedEventIds.add(eventId);
    this.processedEventIds.add(eventId);

    // ── Timestamp & metadata side effects ──
    switch (nextState) {
      case CallState.RESERVED:
        if (options.agentId) call.agentId = options.agentId;
        break;

      case CallState.INITIATED:
        call.initiatedAt = now;
        break;

      case CallState.RINGING:
        call.ringingAt = now;
        break;

      case CallState.ANSWERED:
        call.answeredAt = now;
        call.disposition = CallDisposition.ANSWERED;
        if (call.ringingAt) {
          call.ringDurationMs = now - call.ringingAt;
        } else if (call.initiatedAt) {
          call.ringDurationMs = now - call.initiatedAt;
        }
        break;

      case CallState.CONNECTED:
        call.connectedAt = now;
        call.disposition = CallDisposition.ANSWERED;
        if (options.agentId) call.agentId = options.agentId;
        break;

      case CallState.COMPLETED:
        call.completedAt = now;
        if (!call.disposition) {
          if (call.answeredAt || call.connectedAt) {
            call.disposition = options.disposition || CallDisposition.ANSWERED;
          } else {
            call.disposition = options.disposition || CallDisposition.NO_ANSWER;
          }
        }
        if (call.connectedAt) {
          call.talkDurationMs = now - call.connectedAt;
        }
        if (call.initiatedAt) {
          call.totalDurationMs = now - call.initiatedAt;
        }
        break;

      case CallState.FAILED:
        call.completedAt = now;
        call.disposition = CallDisposition.FAILED;
        call.failureReason = options.failureReason || 'Unknown failure';
        if (call.initiatedAt) {
          call.totalDurationMs = now - call.initiatedAt;
        }
        break;

      case CallState.CANCELLED:
        call.completedAt = now;
        call.disposition = CallDisposition.CANCELLED;
        if (call.initiatedAt) {
          call.totalDurationMs = now - call.initiatedAt;
        }
        break;
    }

    if (options.disposition) {
      call.disposition = options.disposition;
    }

    this.emit('call:transition', {
      callId: call.id,
      previousState,
      newState: nextState,
      event,
      agentId: call.agentId,
    });

    return {
      success: true,
      call: { ...call, processedEventIds: new Set(call.processedEventIds) },
      skipped: false,
    };
  }

  // ─── Process Provider Event ─────────────────────────────────────────────

  /**
   * Process a raw provider call event.
   * Handles deduplication and out-of-order events transparently.
   */
  processProviderEvent(providerEvent: ProviderCallEvent): {
    success: boolean;
    call: Call | null;
    skipped: boolean;
    reason?: string;
  } {
    return this.transition(providerEvent.callId, providerEvent.event, {
      eventId: providerEvent.eventId,
      timestamp: providerEvent.timestamp,
    });
  }

  /**
   * Mark a call as ABANDONED (answered but no agent available).
   * THIS IS A COMPLIANCE VIOLATION — the Safety Controller must prevent this.
   */
  markAbandoned(callId: string): void {
    const call = this.calls.get(callId);
    if (call) {
      call.disposition = CallDisposition.ABANDONED;
      this.emit('call:abandoned', { callId, borrowerId: call.borrowerId });
    }
  }

  // ─── Queries ────────────────────────────────────────────────────────────

  getCall(callId: string): Call | undefined {
    const call = this.calls.get(callId);
    if (!call) return undefined;
    return { ...call, processedEventIds: new Set(call.processedEventIds) };
  }

  getCallDirect(callId: string): Call | undefined {
    return this.calls.get(callId);
  }

  getAllCalls(): Call[] {
    return Array.from(this.calls.values()).map((c) => ({
      ...c,
      processedEventIds: new Set(c.processedEventIds),
    }));
  }

  getCallsByState(state: CallState): Call[] {
    return Array.from(this.calls.values()).filter((c) => c.state === state);
  }

  getRingingCalls(): Call[] {
    return this.getCallsByState(CallState.RINGING);
  }

  getActiveCalls(): Call[] {
    return Array.from(this.calls.values()).filter(
      (c) => !TERMINAL_CALL_STATES.has(c.state)
    );
  }

  getAnsweredUnconnectedCalls(): Call[] {
    return this.getCallsByState(CallState.ANSWERED);
  }

  getCurrentRingingCount(): number {
    return (
      this.getCallsByState(CallState.QUEUED).length +
      this.getCallsByState(CallState.RESERVED).length +
      this.getCallsByState(CallState.INITIATED).length +
      this.getCallsByState(CallState.RINGING).length +
      this.getCallsByState(CallState.ANSWERED).length
    );
  }

  getCurrentInFlightCount(): number {
    return this.getCurrentRingingCount();
  }

  getCurrentConnectedCount(): number {
    return this.getCallsByState(CallState.CONNECTED).length;
  }

  /**
   * Get comprehensive call statistics.
   */
  getStats(): CallStats {
    let totalInitiated = 0;
    let totalAnswered = 0;
    let totalNoAnswer = 0;
    let totalFailed = 0;
    let totalAbandoned = 0;
    let totalCompleted = 0;
    let totalCancelled = 0;
    let currentRinging = 0;
    let currentConnected = 0;
    let ringDurations: number[] = [];
    let talkDurations: number[] = [];

    for (const call of this.calls.values()) {
      if (call.initiatedAt) totalInitiated++;

      if (
        call.disposition === CallDisposition.ANSWERED ||
        call.answeredAt !== null ||
        call.connectedAt !== null ||
        call.state === CallState.ANSWERED ||
        call.state === CallState.CONNECTED
      ) {
        if (call.disposition === CallDisposition.ABANDONED) {
          totalAbandoned++;
        } else {
          totalAnswered++;
        }
      } else if (call.disposition === CallDisposition.NO_ANSWER) {
        totalNoAnswer++;
      } else if (call.disposition === CallDisposition.FAILED) {
        totalFailed++;
      } else if (call.disposition === CallDisposition.CANCELLED) {
        totalCancelled++;
      }

      if (TERMINAL_CALL_STATES.has(call.state)) totalCompleted++;

      if (call.state === CallState.RINGING || call.state === CallState.INITIATED) {
        currentRinging++;
      }
      if (call.state === CallState.CONNECTED) {
        currentConnected++;
      }

      if (call.ringDurationMs !== null) ringDurations.push(call.ringDurationMs);
      if (call.talkDurationMs !== null) talkDurations.push(call.talkDurationMs);
    }

    const answerRate = totalInitiated > 0 ? totalAnswered / totalInitiated : 0;
    const abandonmentRate =
      totalAnswered > 0 ? totalAbandoned / totalAnswered : 0;
    const avgRingDurationMs =
      ringDurations.length > 0
        ? ringDurations.reduce((s, v) => s + v, 0) / ringDurations.length
        : 0;
    const avgTalkDurationMs =
      talkDurations.length > 0
        ? talkDurations.reduce((s, v) => s + v, 0) / talkDurations.length
        : 0;

    return {
      totalInitiated,
      totalAnswered,
      totalNoAnswer,
      totalFailed,
      totalAbandoned,
      totalCompleted,
      totalCancelled,
      answerRate,
      abandonmentRate,
      currentRinging,
      currentConnected,
      avgRingDurationMs,
      avgTalkDurationMs,
    };
  }

  // ─── Reset ──────────────────────────────────────────────────────────────

  reset(): void {
    this.calls.clear();
    this.processedEventIds.clear();
    this.removeAllListeners();
  }
}
