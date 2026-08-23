import { describe, it, expect, beforeEach } from 'vitest';
import { SafetyController } from '../src/safety/safety-controller';
import { CircuitBreaker } from '../src/safety/circuit-breaker';
import { AgentStateMachine } from '../src/state-machine/agent-state-machine';
import { CallStateMachine } from '../src/state-machine/call-state-machine';
import { StatsCollector } from '../src/pacing/stats-collector';
import { AgentEvent } from '../src/types/agent';
import { SafetyDecision, DialProposal } from '../src/types/call';

describe('SafetyController', () => {
  let agentSM: AgentStateMachine;
  let callSM: CallStateMachine;
  let stats: StatsCollector;
  let cb: CircuitBreaker;
  let safety: SafetyController;

  beforeEach(() => {
    agentSM = new AgentStateMachine();
    callSM = new CallStateMachine();
    stats = new StatsCollector(0.3, 8000, 120000, 15000);
    cb = new CircuitBreaker();
    safety = new SafetyController(agentSM, callSM, stats, cb);
  });

  function createAvailableAgents(count: number) {
    const agents = agentSM.createAgents(count);
    for (const a of agents) {
      agentSM.transition(a.id, AgentEvent.LOGIN, a.version);
    }
    return agents;
  }

  describe('Zero-Abandonment Enforcement', () => {
    it('should REJECT when no agents available', () => {
      const proposal: DialProposal = {
        requestedDials: 10,
        reason: 'test',
        pacingMode: 'PREDICTIVE',
      };

      const verdict = safety.evaluate(proposal);
      expect(verdict.decision).toBe(SafetyDecision.REJECT);
      expect(verdict.approvedDials).toBe(0);
    });

    it('should REDUCE when proposed dials would risk abandonment', () => {
      createAvailableAgents(5);

      // High answer rate stats (70%)
      const highStats = new StatsCollector(0.7, 5000, 60000, 10000);
      for (let i = 0; i < 20; i++) {
        highStats.recordCallOutcome(true, 5000, 60000, 10000);
      }
      const safetySC = new SafetyController(agentSM, callSM, highStats, cb);

      // Propose 100 dials for 5 agents with 70%+ answer rate
      const proposal: DialProposal = {
        requestedDials: 100,
        reason: 'test',
        pacingMode: 'PREDICTIVE',
      };

      const verdict = safetySC.evaluate(proposal);
      // Should reduce to safe level
      expect(verdict.approvedDials).toBeLessThan(100);
      expect(verdict.approvedDials).toBeLessThanOrEqual(
        Math.ceil(5 / 0.05) // Safe upper bound
      );
    });

    it('should APPROVE safe proposals', () => {
      createAvailableAgents(10);

      const proposal: DialProposal = {
        requestedDials: 2,
        reason: 'test',
        pacingMode: 'PROGRESSIVE',
      };

      const verdict = safety.evaluate(proposal);
      expect(verdict.decision).toBe(SafetyDecision.APPROVE);
      expect(verdict.approvedDials).toBe(2);
    });
  });

  describe('Circuit Breaker Integration', () => {
    it('should REJECT when circuit breaker is OPEN', () => {
      createAvailableAgents(10);

      // Trip the circuit breaker
      for (let i = 0; i < 20; i++) {
        cb.recordOutcome(false, 10000);
      }

      const proposal: DialProposal = {
        requestedDials: 5,
        reason: 'test',
        pacingMode: 'PREDICTIVE',
      };

      const verdict = safety.evaluate(proposal);
      expect(verdict.decision).toBe(SafetyDecision.REJECT);
      expect(verdict.reason).toContain('Circuit breaker');
    });
  });

  describe('Agent Shock Detection', () => {
    it('should force progressive fallback on sudden agent drop', () => {
      createAvailableAgents(40);

      // First evaluation establishes baseline
      safety.evaluate({
        requestedDials: 5,
        reason: 'test',
        pacingMode: 'PREDICTIVE',
      });

      // Simulate 30 agents logging out (75% drop)
      const available = agentSM.getAgentsByState('AVAILABLE' as any);
      for (let i = 0; i < 30; i++) {
        const a = agentSM.getAgent(available[i].id)!;
        agentSM.transition(a.id, AgentEvent.LOGOUT, a.version);
      }

      // Next evaluation should detect shock
      const verdict = safety.evaluate({
        requestedDials: 20,
        reason: 'test',
        pacingMode: 'PREDICTIVE',
      });

      expect(verdict.decision).toBe(SafetyDecision.FORCE_PROGRESSIVE_FALLBACK);
    });
  });

  describe('Minimum Agent Threshold', () => {
    it('should force progressive when too few agents for predictive', () => {
      createAvailableAgents(2); // Below default threshold of 3

      const proposal: DialProposal = {
        requestedDials: 10,
        reason: 'test',
        pacingMode: 'PREDICTIVE',
      };

      const verdict = safety.evaluate(proposal);
      expect(verdict.decision).toBe(SafetyDecision.FORCE_PROGRESSIVE_FALLBACK);
    });
  });

  describe('Intervention Statistics', () => {
    it('should track intervention counts', () => {
      createAvailableAgents(5);

      // Several proposals
      safety.evaluate({ requestedDials: 2, reason: '', pacingMode: 'PROGRESSIVE' });
      safety.evaluate({ requestedDials: 0, reason: '', pacingMode: 'PROGRESSIVE' });

      const stats = safety.getInterventionStats();
      expect(stats.totalProposals).toBe(2);
      expect(stats.totalApproved + stats.totalReduced + stats.totalRejected + stats.totalForcedProgressive).toBe(2);
    });
  });
});

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({
      errorThreshold: 0.15,
      minRequestsToEvaluate: 5,
      openDurationMs: 100,
    });
  });

  it('should start CLOSED', () => {
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.isClosed()).toBe(true);
  });

  it('should trip to OPEN on high error rate', () => {
    // Record 5 failures
    for (let i = 0; i < 5; i++) {
      cb.recordOutcome(false, 1000);
    }

    // Error rate = 100% > 15% → should trip
    expect(cb.isOpen()).toBe(true);
  });

  it('should transition OPEN → HALF_OPEN after timeout', async () => {
    // Trip the breaker
    for (let i = 0; i < 5; i++) {
      cb.recordOutcome(false, 1000);
    }
    expect(cb.isOpen()).toBe(true);

    // Wait for openDurationMs
    await new Promise((r) => setTimeout(r, 150));

    expect(cb.isHalfOpen()).toBe(true);
  });

  it('should transition HALF_OPEN → CLOSED on successful probes', async () => {
    // Trip → wait → half-open
    for (let i = 0; i < 5; i++) {
      cb.recordOutcome(false, 1000);
    }
    await new Promise((r) => setTimeout(r, 150));
    expect(cb.isHalfOpen()).toBe(true);

    // 3 successful probes (default threshold)
    cb.recordOutcome(true, 100);
    cb.recordOutcome(true, 100);
    cb.recordOutcome(true, 100);

    expect(cb.isClosed()).toBe(true);
  });

  it('should return to OPEN from HALF_OPEN on failure', async () => {
    for (let i = 0; i < 5; i++) {
      cb.recordOutcome(false, 1000);
    }
    await new Promise((r) => setTimeout(r, 150));
    expect(cb.isHalfOpen()).toBe(true);

    // Failure during probe
    cb.recordOutcome(false, 1000);
    expect(cb.isOpen()).toBe(true);
  });
});
