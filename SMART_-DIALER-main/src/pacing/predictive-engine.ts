// ─── Predictive Pacing Engine ────────────────────────────────────────────────
import { DialProposal } from '../types/call.js';
import { AgentState } from '../types/agent.js';
import { AgentStateMachine } from '../state-machine/agent-state-machine.js';
import { CallStateMachine } from '../state-machine/call-state-machine.js';
import { StatsCollector } from './stats-collector.js';

/**
 * PredictiveEngine implements statistical dialing that over-dials beyond
 * 1:1 ratio to maximize agent utilization while minimizing idle time.
 *
 * Mathematical Model:
 *
 *   D_t = max(0, min(D_max_safe, floor( (A_avail + A_free_predicted) / p_ans - C_ringing )))
 *
 * Where:
 *   A_avail         = Currently idle/available agents
 *   A_free_predicted = Agents currently busy whose expected remaining time
 *                      is less than expected ring time (will be free before call connects)
 *   p_ans           = Smoothed EMA answer rate
 *   C_ringing       = Currently outstanding ringing/initiated calls
 *   D_max_safe      = Safety cap from risk budgeting
 *
 * Key Insight (Little's Law application):
 *   Average agents occupied = λ × W
 *   where λ = call arrival rate (we control) and W = average handle time
 *   
 *   To keep all agents busy: λ = N_agents / W
 *   But we must dial more because only p_ans fraction will connect:
 *   Effective dial rate = λ / p_ans
 *
 * The Safety Controller downstream further caps this proposal.
 */
export class PredictiveEngine {
  /** Maximum over-dial ratio relative to available agents */
  private maxOverDialRatio: number = 3.0;

  constructor(
    private agentSM: AgentStateMachine,
    private callSM: CallStateMachine,
    private statsCollector: StatsCollector,
    maxOverDialRatio: number = 3.0
  ) {
    this.maxOverDialRatio = maxOverDialRatio;
  }

  /**
   * Generate a predictive dial proposal with full mathematical reasoning trace.
   */
  propose(): DialProposal {
    const stats = this.statsCollector.getStats();
    const poolStats = this.agentSM.getPoolStats();

    const availableAgents = poolStats.available;
    const currentRinging = this.callSM.getCurrentRingingCount();
    const currentConnected = this.callSM.getCurrentConnectedCount();
    const answerRate = Math.max(stats.answerRate, 0.05); // Floor at 5% to prevent division by zero
    const avgRingTimeMs = stats.avgRingTimeMs;
    const avgTalkTimeMs = stats.avgTalkTimeMs;
    const avgWrapUpTimeMs = stats.avgWrapUpTimeMs;

    // ── Step 1: Estimate agents that will become free during ring time ──
    // Look at agents in CONNECTED and WRAP_UP states
    // Estimate how many will finish before a new call rings and is answered
    const expectedRingToAnswerMs = avgRingTimeMs; // Time from dial to answer
    const predictedFreeAgents = this.estimateFreeAgents(expectedRingToAnswerMs);

    // ── Step 2: Total effective agent capacity ──
    const effectiveAgents = availableAgents + predictedFreeAgents;

    // ── Step 3: Calculate raw dial count ──
    // We need effectiveAgents / p_ans calls to fill all agents
    // But subtract calls already ringing
    const rawDialCount = effectiveAgents / answerRate - currentRinging;

    // ── Step 4: Apply safety cap ──
    // Never dial more than maxOverDialRatio × available agents
    const maxDials = Math.max(1, Math.ceil(availableAgents * this.maxOverDialRatio));
    const cappedDialCount = Math.max(0, Math.min(Math.floor(rawDialCount), maxDials));

    // ── Step 5: Build proposal with full mathematical trace ──
    const formula =
      `D_t = max(0, min(${maxDials}, floor((${availableAgents} + ${predictedFreeAgents.toFixed(1)}) / ${answerRate.toFixed(3)} - ${currentRinging})))`;

    return {
      requestedDials: cappedDialCount,
      reason:
        `Predictive — ${availableAgents} available, ${predictedFreeAgents.toFixed(1)} predicted free within ${(avgRingTimeMs / 1000).toFixed(1)}s ring window. ` +
        `Answer rate: ${(answerRate * 100).toFixed(1)}%, ${currentRinging} ringing, ${currentConnected} connected. ` +
        `Raw: ${rawDialCount.toFixed(1)} → Capped: ${cappedDialCount}.`,
      pacingMode: 'PREDICTIVE',
      mathTrace: {
        availableAgents,
        predictedFreeAgents: Math.round(predictedFreeAgents * 10) / 10,
        currentAnswerRate: answerRate,
        currentRinging,
        formula,
        rawResult: Math.round(rawDialCount * 10) / 10,
        cappedResult: cappedDialCount,
      },
    };
  }

  /**
   * Estimate the number of agents that will become free within the given time window.
   *
   * Uses a survival-function approach:
   *   For each busy agent, compute P(remaining_time ≤ window)
   *   Sum these probabilities for the expected count.
   *
   * Model: Exponential service time distribution
   *   P(remaining ≤ t) = 1 - exp(-t / μ)
   *   where μ = expected remaining service time
   */
  private estimateFreeAgents(windowMs: number): number {
    const stats = this.statsCollector.getStats();
    const avgTalkTimeMs = stats.avgTalkTimeMs;
    const avgWrapUpTimeMs = stats.avgWrapUpTimeMs;
    const now = Date.now();

    let predictedFree = 0;

    // Check CONNECTED agents
    const connectedAgents = this.agentSM.getAgentsByState(AgentState.CONNECTED);
    for (const agent of connectedAgents) {
      const timeInState = now - agent.stateEnteredAt;
      const expectedRemaining = Math.max(0, avgTalkTimeMs + avgWrapUpTimeMs - timeInState);

      if (expectedRemaining <= 0) {
        // Already past expected completion — highly likely to be free
        predictedFree += 0.95;
      } else {
        // Exponential survival probability
        const rate = 1 / Math.max(expectedRemaining, 1);
        const probFree = 1 - Math.exp(-rate * windowMs);
        predictedFree += probFree;
      }
    }

    // Check WRAP_UP agents
    const wrapUpAgents = this.agentSM.getAgentsByState(AgentState.WRAP_UP);
    for (const agent of wrapUpAgents) {
      const timeInState = now - agent.stateEnteredAt;
      const expectedRemaining = Math.max(0, avgWrapUpTimeMs - timeInState);

      if (expectedRemaining <= 0) {
        predictedFree += 0.98;
      } else {
        const rate = 1 / Math.max(expectedRemaining, 1);
        const probFree = 1 - Math.exp(-rate * windowMs);
        predictedFree += probFree;
      }
    }

    return predictedFree;
  }

  /**
   * Update the maximum over-dial ratio.
   */
  setMaxOverDialRatio(ratio: number): void {
    this.maxOverDialRatio = Math.max(1.0, Math.min(ratio, 5.0));
  }
}
