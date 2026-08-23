// ─── Agent Types & Interfaces ───────────────────────────────────────────────

/**
 * Agent lifecycle states in the SmartDialer system.
 * 
 * State Machine:
 *   OFFLINE → AVAILABLE → RESERVED → DIALING → CONNECTED → WRAP_UP → AVAILABLE
 *                 ↕           ↓           ↓          ↓          ↓
 *              PAUSED      AVAILABLE   AVAILABLE  AVAILABLE  AVAILABLE
 *                              (on failure) (on failure)
 */
export enum AgentState {
  OFFLINE = 'OFFLINE',
  AVAILABLE = 'AVAILABLE',
  RESERVED = 'RESERVED',
  DIALING = 'DIALING',
  CONNECTED = 'CONNECTED',
  WRAP_UP = 'WRAP_UP',
  PAUSED = 'PAUSED',
}

/**
 * Events that trigger agent state transitions.
 */
export enum AgentEvent {
  LOGIN = 'LOGIN',
  LOGOUT = 'LOGOUT',
  RESERVE = 'RESERVE',
  DIAL_STARTED = 'DIAL_STARTED',
  CALL_ANSWERED = 'CALL_ANSWERED',
  CALL_ENDED = 'CALL_ENDED',
  WRAP_UP_COMPLETE = 'WRAP_UP_COMPLETE',
  PAUSE = 'PAUSE',
  RESUME = 'RESUME',
  RELEASE = 'RELEASE', // Release reservation (failure/cancel)
}

/**
 * Allowed transitions map: [currentState][event] → nextState | null
 */
export const AGENT_TRANSITIONS: Record<AgentState, Partial<Record<AgentEvent, AgentState>>> = {
  [AgentState.OFFLINE]: {
    [AgentEvent.LOGIN]: AgentState.AVAILABLE,
  },
  [AgentState.AVAILABLE]: {
    [AgentEvent.RESERVE]: AgentState.RESERVED,
    [AgentEvent.PAUSE]: AgentState.PAUSED,
    [AgentEvent.LOGOUT]: AgentState.OFFLINE,
  },
  [AgentState.RESERVED]: {
    [AgentEvent.DIAL_STARTED]: AgentState.DIALING,
    [AgentEvent.RELEASE]: AgentState.AVAILABLE,
    [AgentEvent.LOGOUT]: AgentState.OFFLINE,
  },
  [AgentState.DIALING]: {
    [AgentEvent.CALL_ANSWERED]: AgentState.CONNECTED,
    [AgentEvent.CALL_ENDED]: AgentState.WRAP_UP,
    [AgentEvent.RELEASE]: AgentState.AVAILABLE,
    [AgentEvent.LOGOUT]: AgentState.OFFLINE, // disappears during call setup
  },
  [AgentState.CONNECTED]: {
    [AgentEvent.CALL_ENDED]: AgentState.WRAP_UP,
  },
  [AgentState.WRAP_UP]: {
    [AgentEvent.WRAP_UP_COMPLETE]: AgentState.AVAILABLE,
    [AgentEvent.LOGOUT]: AgentState.OFFLINE,
  },
  [AgentState.PAUSED]: {
    [AgentEvent.RESUME]: AgentState.AVAILABLE,
    [AgentEvent.LOGOUT]: AgentState.OFFLINE,
  },
};

/**
 * Core agent record with Optimistic Concurrency Control (OCC) version field.
 */
export interface Agent {
  id: string;
  name: string;
  state: AgentState;
  /** OCC version — incremented on every state transition */
  version: number;
  /** Current call ID if in DIALING/CONNECTED state */
  currentCallId: string | null;
  /** Timestamp when the agent entered the current state */
  stateEnteredAt: number;
  /** Reservation lease expiry (ms timestamp). Watchdog reclaims after this. */
  reservationExpiry: number | null;
  /** Worker ID that holds this agent's reservation */
  reservedByWorkerId: string | null;
  /** Total calls handled in this session */
  callsHandled: number;
  /** Total connected time in ms */
  totalConnectedTimeMs: number;
  /** Skills for skill-based routing */
  skills: string[];
}

/**
 * Result of an attempted state transition.
 */
export interface AgentTransitionResult {
  success: boolean;
  agent: Agent | null;
  error?: string;
  previousState?: AgentState;
  newState?: AgentState;
}

/**
 * Agent pool statistics snapshot.
 */
export interface AgentPoolStats {
  total: number;
  available: number;
  reserved: number;
  dialing: number;
  connected: number;
  wrapUp: number;
  paused: number;
  offline: number;
}
