import { describe, it, expect, beforeEach } from 'vitest';
import { AgentStateMachine } from '../src/state-machine/agent-state-machine';
import { CallStateMachine } from '../src/state-machine/call-state-machine';
import { Watchdog } from '../src/allocator/watchdog';
import { AgentState, AgentEvent } from '../src/types/agent';
import { CallEvent } from '../src/types/call';

describe('Worker Crash & Watchdog Recovery', () => {
  let agentSM: AgentStateMachine;
  let callSM: CallStateMachine;
  let watchdog: Watchdog;

  beforeEach(() => {
    agentSM = new AgentStateMachine();
    callSM = new CallStateMachine();
    watchdog = new Watchdog(agentSM, callSM, 100, 200);
  });

  describe('Expired Reservation Recovery', () => {
    it('should reclaim agents with expired reservations', async () => {
      // Create 5 agents, reserve them with short TTL (simulating worker crash)
      const agents = agentSM.createAgents(5);
      for (const a of agents) {
        agentSM.transition(a.id, AgentEvent.LOGIN, a.version);
        const updated = agentSM.getAgent(a.id)!;
        agentSM.transition(a.id, AgentEvent.RESERVE, updated.version, {
          workerId: 'crashed-worker',
          reservationTtlMs: 50, // Very short TTL
        });
      }

      // Verify all in RESERVED
      expect(agentSM.getAgentsByState(AgentState.RESERVED)).toHaveLength(5);
      expect(agentSM.getAgentsByState(AgentState.AVAILABLE)).toHaveLength(0);

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 100));

      // Run watchdog sweep
      const result = watchdog.sweep();
      expect(result.agentsReclaimed).toBe(5);

      // All agents should be AVAILABLE again
      expect(agentSM.getAgentsByState(AgentState.AVAILABLE)).toHaveLength(5);
      expect(agentSM.getAgentsByState(AgentState.RESERVED)).toHaveLength(0);
    });

    it('should not reclaim agents with valid (non-expired) reservations', () => {
      const agents = agentSM.createAgents(3);
      for (const a of agents) {
        agentSM.transition(a.id, AgentEvent.LOGIN, a.version);
        const updated = agentSM.getAgent(a.id)!;
        agentSM.transition(a.id, AgentEvent.RESERVE, updated.version, {
          workerId: 'active-worker',
          reservationTtlMs: 60000, // 60 second TTL (not expired)
        });
      }

      const result = watchdog.sweep();
      expect(result.agentsReclaimed).toBe(0);
      expect(agentSM.getAgentsByState(AgentState.RESERVED)).toHaveLength(3);
    });
  });

  describe('Orphaned Call Recovery', () => {
    it('should recover calls stuck in INITIATED state', () => {
      // Create a call and leave it in INITIATED state (simulating provider not responding)
      const call = callSM.createCall('b1', '+1', 'prov-a');
      callSM.transition(call.id, CallEvent.RESERVE);
      callSM.transition(call.id, CallEvent.INITIATE, {
        timestamp: Date.now() - 300, // 300ms ago (> 200ms max staleness)
      });

      // Manually adjust createdAt and initiatedAt for the test
      const callDirect = callSM.getCallDirect(call.id);
      if (callDirect) {
        callDirect.initiatedAt = Date.now() - 300;
      }

      const result = watchdog.sweep();
      expect(result.callsRecovered).toBe(1);
    });
  });

  describe('Agent-Call Mismatch Recovery', () => {
    it('should reclaim agents whose calls have already completed', () => {
      // Create agent and put in DIALING
      const agent = agentSM.createAgent('A');
      agentSM.transition(agent.id, AgentEvent.LOGIN, 0);
      agentSM.transition(agent.id, AgentEvent.RESERVE, 1, { workerId: 'w1' });

      // Create a call and complete it
      const call = callSM.createCall('b1', '+1', 'prov-a');
      callSM.transition(call.id, CallEvent.RESERVE);
      callSM.transition(call.id, CallEvent.INITIATE);
      callSM.transition(call.id, CallEvent.COMPLETE); // Call is done

      // Put agent in DIALING with this call ID
      agentSM.transition(agent.id, AgentEvent.DIAL_STARTED, 2, { callId: call.id });

      // Watchdog should detect mismatch: agent DIALING but call COMPLETED
      const result = watchdog.sweep();
      expect(result.agentsReclaimed).toBe(1);

      const updated = agentSM.getAgent(agent.id)!;
      expect(updated.state).toBe(AgentState.AVAILABLE);
    });
  });

  describe('Watchdog Statistics', () => {
    it('should track sweep statistics', async () => {
      const agent = agentSM.createAgent('A');
      agentSM.transition(agent.id, AgentEvent.LOGIN, 0);
      agentSM.transition(agent.id, AgentEvent.RESERVE, 1, {
        workerId: 'w1',
        reservationTtlMs: 10,
      });

      await new Promise((r) => setTimeout(r, 50));
      watchdog.sweep();
      watchdog.sweep();

      const stats = watchdog.getStats();
      expect(stats.totalSweeps).toBe(2);
      expect(stats.totalAgentsReclaimed).toBe(1);
    });
  });
});
