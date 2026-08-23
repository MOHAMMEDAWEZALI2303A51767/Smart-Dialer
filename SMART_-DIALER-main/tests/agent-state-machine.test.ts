import { describe, it, expect, beforeEach } from 'vitest';
import {
  AgentStateMachine,
  ConcurrencyConflictError,
  InvalidTransitionError,
} from '../src/state-machine/agent-state-machine';
import { AgentState, AgentEvent } from '../src/types/agent';

describe('AgentStateMachine', () => {
  let sm: AgentStateMachine;

  beforeEach(() => {
    sm = new AgentStateMachine();
  });

  describe('Agent Creation', () => {
    it('should create an agent in OFFLINE state', () => {
      const agent = sm.createAgent('Test Agent');
      expect(agent.state).toBe(AgentState.OFFLINE);
      expect(agent.version).toBe(0);
      expect(agent.currentCallId).toBeNull();
    });

    it('should bulk-create agents', () => {
      const agents = sm.createAgents(10, 'Agent');
      expect(agents).toHaveLength(10);
      agents.forEach((a, i) => {
        expect(a.name).toBe(`Agent-${i + 1}`);
        expect(a.state).toBe(AgentState.OFFLINE);
      });
    });
  });

  describe('State Transitions', () => {
    it('should transition OFFLINE → AVAILABLE on LOGIN', () => {
      const agent = sm.createAgent('A');
      const result = sm.transition(agent.id, AgentEvent.LOGIN, 0);
      expect(result.success).toBe(true);
      expect(result.newState).toBe(AgentState.AVAILABLE);
      expect(result.agent!.version).toBe(1);
    });

    it('should transition through full lifecycle', () => {
      const agent = sm.createAgent('A');
      sm.transition(agent.id, AgentEvent.LOGIN, 0);
      sm.transition(agent.id, AgentEvent.RESERVE, 1, { workerId: 'w1' });
      sm.transition(agent.id, AgentEvent.DIAL_STARTED, 2, { callId: 'c1' });
      sm.transition(agent.id, AgentEvent.CALL_ANSWERED, 3);
      sm.transition(agent.id, AgentEvent.CALL_ENDED, 4);
      sm.transition(agent.id, AgentEvent.WRAP_UP_COMPLETE, 5);

      const final = sm.getAgent(agent.id)!;
      expect(final.state).toBe(AgentState.AVAILABLE);
      expect(final.version).toBe(6);
      expect(final.callsHandled).toBe(1);
    });

    it('should throw InvalidTransitionError for invalid transitions', () => {
      const agent = sm.createAgent('A');
      expect(() => {
        sm.transition(agent.id, AgentEvent.RESERVE, 0);
      }).toThrow(InvalidTransitionError);
    });

    it('should handle PAUSE and RESUME', () => {
      const agent = sm.createAgent('A');
      sm.transition(agent.id, AgentEvent.LOGIN, 0);
      sm.transition(agent.id, AgentEvent.PAUSE, 1);

      const paused = sm.getAgent(agent.id)!;
      expect(paused.state).toBe(AgentState.PAUSED);

      sm.transition(agent.id, AgentEvent.RESUME, 2);
      const resumed = sm.getAgent(agent.id)!;
      expect(resumed.state).toBe(AgentState.AVAILABLE);
    });
  });

  describe('Optimistic Concurrency Control', () => {
    it('should throw ConcurrencyConflictError on version mismatch', () => {
      const agent = sm.createAgent('A');
      sm.transition(agent.id, AgentEvent.LOGIN, 0);

      // First transition succeeds (version 1 → 2)
      sm.transition(agent.id, AgentEvent.RESERVE, 1, { workerId: 'w1' });

      // Second attempt with stale version (1) should fail
      expect(() => {
        sm.transition(agent.id, AgentEvent.RESERVE, 1, { workerId: 'w2' });
      }).toThrow(ConcurrencyConflictError);
    });

    it('should handle 50 concurrent workers reserving 10 agents', () => {
      // Create 10 available agents
      const agents = sm.createAgents(10);
      for (const a of agents) {
        sm.transition(a.id, AgentEvent.LOGIN, a.version);
      }

      // 50 workers try to reserve
      let successCount = 0;
      let conflictCount = 0;
      const reservedIds = new Set<string>();

      for (let i = 0; i < 50; i++) {
        const result = sm.reserveAvailableAgent(`worker-${i}`);
        if (result) {
          successCount++;
          reservedIds.add(result.id);
        } else {
          conflictCount++;
        }
      }

      // Exactly 10 should succeed, 40 should fail
      expect(successCount).toBe(10);
      expect(conflictCount).toBe(40);
      expect(reservedIds.size).toBe(10);
    });
  });

  describe('Lease Management', () => {
    it('should detect expired reservations', async () => {
      const agent = sm.createAgent('A');
      sm.transition(agent.id, AgentEvent.LOGIN, 0);
      sm.transition(agent.id, AgentEvent.RESERVE, 1, {
        workerId: 'w1',
        reservationTtlMs: 50,
      });

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 100));

      const expired = sm.getExpiredReservations();
      expect(expired).toHaveLength(1);
      expect(expired[0].id).toBe(agent.id);
    });

    it('should force-release expired agents', async () => {
      const agent = sm.createAgent('A');
      sm.transition(agent.id, AgentEvent.LOGIN, 0);
      sm.transition(agent.id, AgentEvent.RESERVE, 1, {
        workerId: 'w1',
        reservationTtlMs: 50,
      });

      await new Promise((r) => setTimeout(r, 100));

      const result = sm.forceRelease(agent.id);
      expect(result.success).toBe(true);
      expect(result.newState).toBe(AgentState.AVAILABLE);

      const updated = sm.getAgent(agent.id)!;
      expect(updated.state).toBe(AgentState.AVAILABLE);
      expect(updated.reservedByWorkerId).toBeNull();
    });
  });

  describe('Pool Statistics', () => {
    it('should return correct pool stats', () => {
      sm.createAgents(5);
      const agents = sm.getAllAgents();

      sm.transition(agents[0].id, AgentEvent.LOGIN, 0);
      sm.transition(agents[1].id, AgentEvent.LOGIN, 0);
      sm.transition(agents[2].id, AgentEvent.LOGIN, 0);

      const stats = sm.getPoolStats();
      expect(stats.total).toBe(5);
      expect(stats.available).toBe(3);
      expect(stats.offline).toBe(2);
    });
  });
});
