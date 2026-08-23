// ─── Call Types & Interfaces ────────────────────────────────────────────────

/**
 * Call lifecycle states.
 *
 * State Machine:
 *   QUEUED → RESERVED → INITIATED → RINGING → ANSWERED → CONNECTED → COMPLETED
 *              ↓           ↓          ↓          ↓          ↓
 *           CANCELLED    FAILED    FAILED     FAILED     FAILED
 *
 * Out-of-order handling: Terminal states (COMPLETED, FAILED, CANCELLED)
 * are reachable from ANY non-terminal state to handle provider event disorder.
 */
export enum CallState {
  QUEUED = 'QUEUED',
  RESERVED = 'RESERVED',
  INITIATED = 'INITIATED',
  RINGING = 'RINGING',
  ANSWERED = 'ANSWERED',
  CONNECTED = 'CONNECTED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

/**
 * Events that trigger call state transitions.
 */
export enum CallEvent {
  RESERVE = 'RESERVE',
  INITIATE = 'INITIATE',
  RING = 'RING',
  ANSWER = 'ANSWER',
  CONNECT = 'CONNECT',
  COMPLETE = 'COMPLETE',
  FAIL = 'FAIL',
  CANCEL = 'CANCEL',
  NO_ANSWER = 'NO_ANSWER',
}

/** Terminal states — no further transitions allowed FROM these states */
export const TERMINAL_CALL_STATES = new Set([
  CallState.COMPLETED,
  CallState.FAILED,
  CallState.CANCELLED,
]);

/**
 * Allowed transitions map.
 * Terminal states (COMPLETED, FAILED, CANCELLED) are reachable from
 * ALL non-terminal states to handle out-of-order provider events gracefully.
 */
export const CALL_TRANSITIONS: Record<CallState, Partial<Record<CallEvent, CallState>>> = {
  [CallState.QUEUED]: {
    [CallEvent.RESERVE]: CallState.RESERVED,
    [CallEvent.FAIL]: CallState.FAILED,
    [CallEvent.CANCEL]: CallState.CANCELLED,
  },
  [CallState.RESERVED]: {
    [CallEvent.INITIATE]: CallState.INITIATED,
    [CallEvent.FAIL]: CallState.FAILED,
    [CallEvent.CANCEL]: CallState.CANCELLED,
    [CallEvent.COMPLETE]: CallState.COMPLETED,
  },
  [CallState.INITIATED]: {
    [CallEvent.RING]: CallState.RINGING,
    [CallEvent.ANSWER]: CallState.ANSWERED,       // skip-ahead (out-of-order)
    [CallEvent.COMPLETE]: CallState.COMPLETED,     // skip-ahead
    [CallEvent.FAIL]: CallState.FAILED,
    [CallEvent.CANCEL]: CallState.CANCELLED,
  },
  [CallState.RINGING]: {
    [CallEvent.ANSWER]: CallState.ANSWERED,
    [CallEvent.NO_ANSWER]: CallState.COMPLETED,
    [CallEvent.COMPLETE]: CallState.COMPLETED,     // skip-ahead
    [CallEvent.FAIL]: CallState.FAILED,
    [CallEvent.CANCEL]: CallState.CANCELLED,
  },
  [CallState.ANSWERED]: {
    [CallEvent.CONNECT]: CallState.CONNECTED,
    [CallEvent.COMPLETE]: CallState.COMPLETED,     // skip-ahead
    [CallEvent.FAIL]: CallState.FAILED,
    [CallEvent.CANCEL]: CallState.CANCELLED,
  },
  [CallState.CONNECTED]: {
    [CallEvent.COMPLETE]: CallState.COMPLETED,
    [CallEvent.FAIL]: CallState.FAILED,
  },
  // Terminal states — no outgoing transitions
  [CallState.COMPLETED]: {},
  [CallState.FAILED]: {},
  [CallState.CANCELLED]: {},
};

/**
 * Call disposition — outcome classification.
 */
export enum CallDisposition {
  ANSWERED = 'ANSWERED',
  NO_ANSWER = 'NO_ANSWER',
  BUSY = 'BUSY',
  VOICEMAIL = 'VOICEMAIL',
  FAILED = 'FAILED',
  ABANDONED = 'ABANDONED',   // Answered but no agent available — compliance violation!
  CANCELLED = 'CANCELLED',
}

/**
 * Borrower (lead) lifecycle for concurrent-safe allocation.
 */
export enum BorrowerStatus {
  READY = 'READY',
  CLAIMED = 'CLAIMED',
  IN_CALL = 'IN_CALL',
  COMPLETED = 'COMPLETED',
  EXHAUSTED = 'EXHAUSTED',
}

/**
 * Borrower (lead) record to dial.
 */
export interface Borrower {
  id: string;
  name: string;
  phoneNumber: string;
  accountId: string;
  priority: number;           // Higher = more urgent
  timezone: string;
  lastDialedAt: number | null;
  dialAttempts: number;
  maxAttempts: number;
  status: BorrowerStatus;
  /** OCC version — incremented on every claim/release */
  version: number;
  claimedByWorkerId: string | null;
  claimedAt: number | null;
}

/**
 * Core call record.
 */
export interface Call {
  id: string;
  borrowerId: string;
  borrowerPhone: string;
  agentId: string | null;
  state: CallState;
  disposition: CallDisposition | null;
  /** Provider used for this call */
  providerId: string;
  /** Timestamps for lifecycle tracking */
  createdAt: number;
  initiatedAt: number | null;
  ringingAt: number | null;
  answeredAt: number | null;
  connectedAt: number | null;
  completedAt: number | null;
  /** Ring duration in ms */
  ringDurationMs: number | null;
  /** Talk duration in ms */
  talkDurationMs: number | null;
  /** Total duration from initiation to completion */
  totalDurationMs: number | null;
  /** Set of processed event IDs for deduplication */
  processedEventIds: Set<string>;
  /** Error details if failed */
  failureReason: string | null;
}

/**
 * Provider event delivered via webhook.
 */
export interface ProviderCallEvent {
  eventId: string;
  callId: string;
  event: CallEvent;
  timestamp: number;
  providerId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Call statistics snapshot.
 */
export interface CallStats {
  totalInitiated: number;
  totalAnswered: number;
  totalNoAnswer: number;
  totalFailed: number;
  totalAbandoned: number;
  totalCompleted: number;
  totalCancelled: number;
  answerRate: number;
  abandonmentRate: number;
  avgRingDurationMs: number;
  avgTalkDurationMs: number;
  currentRinging: number;
  currentConnected: number;
}

/**
 * Dial proposal from pacing engine to safety controller.
 */
export interface DialProposal {
  requestedDials: number;
  reason: string;
  pacingMode: 'PROGRESSIVE' | 'PREDICTIVE';
  /** Mathematical reasoning trace for predictive mode */
  mathTrace?: {
    availableAgents: number;
    predictedFreeAgents: number;
    currentAnswerRate: number;
    currentRinging: number;
    formula: string;
    rawResult: number;
    cappedResult: number;
  };
}

/**
 * Safety controller decision on a dial proposal.
 */
export enum SafetyDecision {
  APPROVE = 'APPROVE',
  REDUCE = 'REDUCE',
  REJECT = 'REJECT',
  FORCE_PROGRESSIVE_FALLBACK = 'FORCE_PROGRESSIVE_FALLBACK',
}

export interface SafetyVerdict {
  decision: SafetyDecision;
  approvedDials: number;
  originalProposal: number;
  reason: string;
  riskScore: number;          // 0.0 - 1.0
  interventionDetails?: string;
}
