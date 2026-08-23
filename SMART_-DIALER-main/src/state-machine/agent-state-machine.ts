// ─── Agent State Machine with Optimistic Concurrency Control ────────────────
import {
  Agent,
  AgentState,
  AgentEvent,
  AgentTransitionResult,
  AgentPoolStats,
  AGENT_TRANSITIONS,
} from '../types/agent.js';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

/**
 * ConcurrencyConflictError — thrown when a CAS operation fails
 * because the agent's version has changed since it was read.
 */
export class ConcurrencyConflictError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number
  ) {
    super(
      `CAS conflict on agent ${agentId}: expected version ${expectedVersion}, found ${actualVersion}`
    );
    this.name = 'ConcurrencyConflictError';
  }
}

/**
 * InvalidTransitionError — thrown when an event is not valid for the current state.
 */
export class InvalidTransitionError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly currentState: AgentState,
    public readonly event: AgentEvent
  ) {
    super(
      `Invalid transition: agent ${agentId} in state ${currentState} cannot handle event ${event}`
    );
    this.name = 'InvalidTransitionError';
  }
}

const DEFAULT_RESERVATION_TTL_MS = 30_000; // 30 seconds

/**
 * AgentStateMachine manages the lifecycle of all agents with:
 * - Optimistic Concurrency Control (CAS-based versioned updates)
 * - Reservation lease TTLs for crash recovery
 * - Event-driven notifications for state changes
 *
 * Two workers attempting to reserve the same agent simultaneously:
 *   Worker A: compareAndSwap(agentId, AVAILABLE, v=5, RESERVED, v=6) → SUCCESS
 *   Worker B: compareAndSwap(agentId, AVAILABLE, v=5, RESERVED, v=6) → CONFLICT (v is now 6)
 */
export class AgentStateMachine extends EventEmitter {
  private agents: Map<string, Agent> = new Map();

  constructor() {
    super();
  }

  // ─── Agent Creation ─────────────────────────────────────────────────────

  /**
   * Create a new agent in OFFLINE state.
   */
  createAgent(name: string, skills: string[] = []): Agent {
    const agent: Agent = {
      id: uuidv4(),
      name,
      state: AgentState.OFFLINE,
      version: 0,
      currentCallId: null,
      stateEnteredAt: Date.now(),
      reservationExpiry: null,
      reservedByWorkerId: null,
      callsHandled: 0,
      totalConnectedTimeMs: 0,
      skills,
    };
    this.agents.set(agent.id, agent);
    this.emit('agent:created', agent);
    return agent;
  }

  /**
   * Bulk-create agents.
   */
  createAgents(count: number, namePrefix: string = 'Agent', skills: string[] = []): Agent[] {
    const agents: Agent[] = [];
    for (let i = 0; i < count; i++) {
      agents.push(this.createAgent(`${namePrefix}-${i + 1}`, skills));
    }
    return agents;
  }

  // ─── State Transitions ─────────────────────────────────────────────────

  /**
   * Attempt to transition an agent's state via the given event.
   * Validates the transition against the state machine and applies OCC.
   *
   * @param agentId - ID of the agent
   * @param event - The event to apply
   * @param expectedVersion - The version the caller expects (for CAS)
   * @param options - Additional transition context
   */
  transition(
    agentId: string,
    event: AgentEvent,
    expectedVersion: number,
    options: {
      workerId?: string;
      callId?: string;
      reservationTtlMs?: number;
    } = {}
  ): AgentTransitionResult {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { success: false, agent: null, error: `Agent ${agentId} not found` };
    }

    // ── OCC: Compare-And-Swap version check ──
    if (agent.version !== expectedVersion) {
      throw new ConcurrencyConflictError(agentId, expectedVersion, agent.version);
    }

    // ── Validate transition ──
    const allowedTransitions = AGENT_TRANSITIONS[agent.state];
    const nextState = allowedTransitions[event];
    if (!nextState) {
      throw new InvalidTransitionError(agentId, agent.state, event);
    }

    const previousState = agent.state;

    // ── Apply transition ──
    agent.state = nextState;
    agent.version += 1;
    agent.stateEnteredAt = Date.now();

    // ── State-specific side effects ──
    switch (nextState) {
      case AgentState.RESERVED:
        agent.reservedByWorkerId = options.workerId || null;
        agent.reservationExpiry =
          Date.now() + (options.reservationTtlMs || DEFAULT_RESERVATION_TTL_MS);
        break;

      case AgentState.DIALING:
        agent.currentCallId = options.callId || null;
        break;

      case AgentState.CONNECTED:
        agent.currentCallId = options.callId || agent.currentCallId;
        break;

      case AgentState.WRAP_UP:
        // Track connected time
        if (previousState === AgentState.CONNECTED && agent.currentCallId) {
          // talkDurationMs is tracked at call level, here we just increment count
          agent.callsHandled += 1;
        }
        break;

      case AgentState.AVAILABLE:
        agent.currentCallId = null;
        agent.reservedByWorkerId = null;
        agent.reservationExpiry = null;
        break;

      case AgentState.OFFLINE:
        agent.currentCallId = null;
        agent.reservedByWorkerId = null;
        agent.reservationExpiry = null;
        break;
    }

    this.emit('agent:transition', {
      agentId: agent.id,
      previousState,
      newState: nextState,
      event,
      version: agent.version,
    });

    return {
      success: true,
      agent: { ...agent },
      previousState,
      newState: nextState,
    };
  }

  // ─── Atomic Reserve ─────────────────────────────────────────────────────

  /**
   * Atomically reserve the first available agent.
   * Scans AVAILABLE agents and attempts CAS reservation.
   * Returns reserved agent or null if none available.
   *
   * This is the core concurrency-safe operation that prevents double-allocation.
   */
  reserveAvailableAgent(workerId: string, reservationTtlMs?: number): Agent | null {
    const availableAgents = this.getAgentsByState(AgentState.AVAILABLE);

    for (const agent of availableAgents) {
      try {
        const result = this.transition(agent.id, AgentEvent.RESERVE, agent.version, {
          workerId,
          reservationTtlMs,
        });
        if (result.success && result.agent) {
          return result.agent;
        }
      } catch (err) {
        if (err instanceof ConcurrencyConflictError) {
          // Another worker beat us — try next agent
          continue;
        }
        throw err;
      }
    }
    return null; // No agent available
  }

  // ─── Queries ────────────────────────────────────────────────────────────

  getAgent(agentId: string): Agent | undefined {
    const agent = this.agents.get(agentId);
    return agent ? { ...agent } : undefined;
  }

  getAgentDirect(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  getAllAgents(): Agent[] {
    return Array.from(this.agents.values()).map((a) => ({ ...a }));
  }

  getAgentsByState(state: AgentState): Agent[] {
    return Array.from(this.agents.values()).filter((a) => a.state === state);
  }

  getAvailableCount(): number {
    return this.getAgentsByState(AgentState.AVAILABLE).length;
  }

  getPoolStats(): AgentPoolStats {
    const stats: AgentPoolStats = {
      total: this.agents.size,
      available: 0,
      reserved: 0,
      dialing: 0,
      connected: 0,
      wrapUp: 0,
      paused: 0,
      offline: 0,
    };

    for (const agent of this.agents.values()) {
      switch (agent.state) {
        case AgentState.AVAILABLE: stats.available++; break;
        case AgentState.RESERVED: stats.reserved++; break;
        case AgentState.DIALING: stats.dialing++; break;
        case AgentState.CONNECTED: stats.connected++; break;
        case AgentState.WRAP_UP: stats.wrapUp++; break;
        case AgentState.PAUSED: stats.paused++; break;
        case AgentState.OFFLINE: stats.offline++; break;
      }
    }
    return stats;
  }

  // ─── Lease Management ──────────────────────────────────────────────────

  /**
   * Find agents with expired reservations (for watchdog).
   */
  getExpiredReservations(): Agent[] {
    const now = Date.now();
    return Array.from(this.agents.values()).filter(
      (a) =>
        a.state === AgentState.RESERVED &&
        a.reservationExpiry !== null &&
        a.reservationExpiry < now
    );
  }

  /**
   * Force-release an agent with an expired reservation.
   * Used by the Watchdog to reclaim agents after worker crashes.
   */
  forceRelease(agentId: string): AgentTransitionResult {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { success: false, agent: null, error: `Agent ${agentId} not found` };
    }

    // Force release — bypass normal CAS (watchdog privilege)
    const previousState = agent.state;
    agent.state = AgentState.AVAILABLE;
    agent.version += 1;
    agent.currentCallId = null;
    agent.reservedByWorkerId = null;
    agent.reservationExpiry = null;
    agent.stateEnteredAt = Date.now();

    this.emit('agent:force-released', {
      agentId: agent.id,
      previousState,
      reason: 'Lease expired — watchdog reclaimed',
    });

    return {
      success: true,
      agent: { ...agent },
      previousState,
      newState: AgentState.AVAILABLE,
    };
  }

  /**
   * Force set agent state (for simulation purposes — bypasses state machine).
   */
  forceSetState(agentId: string, state: AgentState): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.state = state;
      agent.version += 1;
      agent.stateEnteredAt = Date.now();
      if (state === AgentState.AVAILABLE) {
        agent.currentCallId = null;
        agent.reservedByWorkerId = null;
        agent.reservationExpiry = null;
      }
    }
  }

  // ─── Reset ──────────────────────────────────────────────────────────────

  reset(): void {
    this.agents.clear();
    this.removeAllListeners();
  }
}
