import { describe, it, expect, beforeEach } from 'vitest';
import { PredictiveEngine } from '../src/pacing/predictive-engine';
import { ProgressiveEngine } from '../src/pacing/progressive-engine';
import { StatsCollector } from '../src/pacing/stats-collector';
import { AgentStateMachine } from '../src/state-machine/agent-state-machine';
import { CallStateMachine } from '../src/state-machine/call-state-machine';
import { AgentEvent } from '../src/types/agent';

describe('PredictiveEngine', () => {
  let agentSM: AgentStateMachine;
  let callSM: CallStateMachine;
  let stats: StatsCollector;
  let engine: PredictiveEngine;

  beforeEach(() => {
    agentSM = new AgentStateMachine();
    callSM = new CallStateMachine();
    stats = new StatsCollector(0.3, 8000, 120000, 15000);
    engine = new PredictiveEngine(agentSM, callSM, stats);
  });

  it('should propose 0 dials when no agents available', () => {
    const proposal = engine.propose();
    expect(proposal.requestedDials).toBe(0);
    expect(proposal.pacingMode).toBe('PREDICTIVE');
  });

  it('should propose more dials than available agents (over-dial)', () => {
    // Create 10 available agents
    const agents = agentSM.createAgents(10);
    for (const a of agents) {
      agentSM.transition(a.id, AgentEvent.LOGIN, a.version);
    }

    // With 30% answer rate, should propose ~10/0.3 ≈ 33 but capped at 3x = 30
    const proposal = engine.propose();
    expect(proposal.requestedDials).toBeGreaterThan(10);
    expect(proposal.requestedDials).toBeLessThanOrEqual(30); // maxOverDialRatio = 3.0
    expect(proposal.mathTrace).toBeDefined();
    expect(proposal.mathTrace!.availableAgents).toBe(10);
  });

  it('should include mathematical reasoning trace', () => {
    const agents = agentSM.createAgents(5);
    for (const a of agents) {
      agentSM.transition(a.id, AgentEvent.LOGIN, a.version);
    }

    const proposal = engine.propose();
    expect(proposal.mathTrace).toBeDefined();
    expect(proposal.mathTrace!.formula).toContain('max');
    expect(proposal.mathTrace!.formula).toContain('min');
    expect(proposal.mathTrace!.formula).toContain('floor');
  });

  it('should adapt to different answer rates', () => {
    const agents = agentSM.createAgents(10);
    for (const a of agents) {
      agentSM.transition(a.id, AgentEvent.LOGIN, a.version);
    }

    // Low answer rate → more dials needed
    const lowStats = new StatsCollector(0.1, 8000, 120000, 15000);
    const lowEngine = new PredictiveEngine(agentSM, callSM, lowStats);
    const lowProposal = lowEngine.propose();

    // High answer rate → fewer dials needed
    const highStats = new StatsCollector(0.8, 8000, 120000, 15000);
    const highEngine = new PredictiveEngine(agentSM, callSM, highStats);
    const highProposal = highEngine.propose();

    expect(lowProposal.requestedDials).toBeGreaterThan(highProposal.requestedDials);
  });
});

describe('ProgressiveEngine', () => {
  let agentSM: AgentStateMachine;
  let callSM: CallStateMachine;
  let engine: ProgressiveEngine;

  beforeEach(() => {
    agentSM = new AgentStateMachine();
    callSM = new CallStateMachine();
    engine = new ProgressiveEngine(agentSM, callSM);
  });

  it('should propose 1:1 dials — equal to available agents', () => {
    const agents = agentSM.createAgents(5);
    for (const a of agents) {
      agentSM.transition(a.id, AgentEvent.LOGIN, a.version);
    }

    const proposal = engine.propose();
    expect(proposal.requestedDials).toBe(5);
    expect(proposal.pacingMode).toBe('PROGRESSIVE');
  });

  it('should subtract currently ringing calls', () => {
    const agents = agentSM.createAgents(5);
    for (const a of agents) {
      agentSM.transition(a.id, AgentEvent.LOGIN, a.version);
    }

    // Create 2 ringing calls
    const c1 = callSM.createCall('b1', '+1', 'p');
    callSM.transition(c1.id, 'RESERVE' as any);
    callSM.transition(c1.id, 'INITIATE' as any);

    const c2 = callSM.createCall('b2', '+1', 'p');
    callSM.transition(c2.id, 'RESERVE' as any);
    callSM.transition(c2.id, 'INITIATE' as any);

    const proposal = engine.propose();
    expect(proposal.requestedDials).toBe(3); // 5 agents - 2 ringing
  });

  it('should propose 0 when no agents available', () => {
    const proposal = engine.propose();
    expect(proposal.requestedDials).toBe(0);
  });
});

describe('StatsCollector', () => {
  it('should track EMA answer rate', () => {
    const sc = new StatsCollector(0.5, 5000, 60000, 10000);

    // Record 10 answered calls
    for (let i = 0; i < 10; i++) {
      sc.recordCallOutcome(true, 5000, 60000, 10000);
    }

    // Answer rate should be close to 1.0
    expect(sc.getAnswerRate()).toBeGreaterThan(0.8);

    // Record 10 unanswered calls
    for (let i = 0; i < 10; i++) {
      sc.recordCallOutcome(false, 5000);
    }

    // Answer rate should have decreased
    expect(sc.getAnswerRate()).toBeLessThan(0.8);
  });

  it('should provide conservative answer rate', () => {
    const sc = new StatsCollector(0.3, 5000, 60000, 10000);

    // Record mixed outcomes
    for (let i = 0; i < 20; i++) {
      sc.recordCallOutcome(i % 3 === 0, 5000, 60000, 10000);
    }

    const conservative = sc.getConservativeAnswerRate();
    const normal = sc.getAnswerRate();

    // Conservative should be >= normal (higher = more risk = more conservative)
    expect(conservative).toBeGreaterThanOrEqual(normal);
  });
});
