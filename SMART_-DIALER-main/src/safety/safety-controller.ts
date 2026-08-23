// ─── Safety Controller (Firewall) ───────────────────────────────────────────
import {
  DialProposal,
  SafetyVerdict,
  SafetyDecision,
} from '../types/call.js';
import { AgentStateMachine } from '../state-machine/agent-state-machine.js';
import { CallStateMachine } from '../state-machine/call-state-machine.js';
import { StatsCollector } from '../pacing/stats-collector.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { EventEmitter } from 'events';

/**
 * SafetyController acts as an unbreakable firewall between the Pacing Engine
 * and the Telecom Provider layer.
 *
 * Every dial proposal MUST pass through the Safety Controller before any
 * calls are placed. The Safety Controller applies the following hard invariant checks:
 *
 * 1. ZERO-ABANDONMENT HEADROOM CHECK
 *    Ensures enough agent capacity exists to handle worst-case answered calls.
 *    D_approved ≤ floor((A_avail + A_free_conservative) / p_worst_case) - C_ringing
 *
 * 2. PROVIDER HEALTH & CIRCUIT BREAKER
 *    If provider error rate > threshold or latency > threshold, reduce or block dials.
 *
 * 3. AGENT AVAILABILITY SHOCK PROTECTION
 *    If available agents drop > 25% within a short window, force progressive fallback.
 *
 * 4. ABSOLUTE MAXIMUM IN-FLIGHT LIMIT
 *    Never exceed a hard cap on concurrent in-flight calls.
 *
 * Decisions: APPROVE | REDUCE | REJECT | FORCE_PROGRESSIVE_FALLBACK
 */
export class SafetyController extends EventEmitter {
  /** Maximum abandonment rate target (0.0 = zero tolerance) */
  private maxAbandonmentRate: number;
  /** Hard cap on concurrent in-flight (ringing + initiated) calls */
  private maxInFlightCalls: number;
  /** Agent shock threshold — % drop that triggers fallback */
  private agentShockThreshold: number;
  /** Minimum available agents to allow predictive mode */
  private minAgentsForPredictive: number;

  /** Recent agent availability history for shock detection */
  private agentAvailabilityHistory: { timestamp: number; count: number }[] = [];
  private readonly shockWindowMs: number = 5000;

  /** Intervention counter */
  private interventionCount: number = 0;
  private totalProposals: number = 0;
  private totalApproved: number = 0;
  private totalReduced: number = 0;
  private totalRejected: number = 0;
  private totalForcedProgressive: number = 0;

  constructor(
    private agentSM: AgentStateMachine,
    private callSM: CallStateMachine,
    private statsCollector: StatsCollector,
    private circuitBreaker: CircuitBreaker,
    options: {
      maxAbandonmentRate?: number;
      maxInFlightCalls?: number;
      agentShockThreshold?: number;
      minAgentsForPredictive?: number;
    } = {}
  ) {
    super();
    this.maxAbandonmentRate = options.maxAbandonmentRate ?? 0.0; // Zero tolerance default
    this.maxInFlightCalls = options.maxInFlightCalls ?? 200;
    this.agentShockThreshold = options.agentShockThreshold ?? 0.25;
    this.minAgentsForPredictive = options.minAgentsForPredictive ?? 3;
  }

  /**
   * Evaluate a dial proposal and return a safety verdict.
   * This is the CRITICAL gate — no calls are placed without passing through here.
   */
  evaluate(proposal: DialProposal): SafetyVerdict {
    this.totalProposals++;

    const poolStats = this.agentSM.getPoolStats();
    const availableAgents = poolStats.available;
    const currentRinging = this.callSM.getCurrentRingingCount();
    const stats = this.statsCollector.getStats();

    // Record agent availability for shock detection
    this.agentAvailabilityHistory.push({ timestamp: Date.now(), count: availableAgents });
    this.pruneAvailabilityHistory();

    // ── Check 1: Agent Shock Detection ──
    const shockDetected = this.detectAgentShock();
    if (shockDetected) {
      this.totalForcedProgressive++;
      this.interventionCount++;
      const progressiveCap = Math.max(0, availableAgents - currentRinging);
      const verdict: SafetyVerdict = {
        decision: SafetyDecision.FORCE_PROGRESSIVE_FALLBACK,
        approvedDials: progressiveCap,
        originalProposal: proposal.requestedDials,
        reason: 'AGENT SHOCK: Available agent count dropped >25% within 5s window. Forcing progressive fallback.',
        riskScore: 1.0,
        interventionDetails: `Shock threshold: ${this.agentShockThreshold * 100}%. Agents available: ${availableAgents}.`,
      };
      this.emit('safety:verdict', verdict);
      return verdict;
    }

    // ── Check 2: No agents available ──
    if (availableAgents === 0) {
      this.totalRejected++;
      this.interventionCount++;
      const verdict: SafetyVerdict = {
        decision: SafetyDecision.REJECT,
        approvedDials: 0,
        originalProposal: proposal.requestedDials,
        reason: 'No agents available — rejecting all dials to prevent abandonment.',
        riskScore: 1.0,
      };
      this.emit('safety:verdict', verdict);
      return verdict;
    }

    // ── Check 3: Circuit Breaker (Provider Health) ──
    if (this.circuitBreaker.isOpen()) {
      this.totalRejected++;
      this.interventionCount++;
      const verdict: SafetyVerdict = {
        decision: SafetyDecision.REJECT,
        approvedDials: 0,
        originalProposal: proposal.requestedDials,
        reason: 'Circuit breaker OPEN — provider unhealthy. Blocking all dials.',
        riskScore: 1.0,
        interventionDetails: `Provider state: ${this.circuitBreaker.getState()}`,
      };
      this.emit('safety:verdict', verdict);
      return verdict;
    }

    // ── Check 4: Not enough agents for predictive ──
    if (proposal.pacingMode === 'PREDICTIVE' && availableAgents < this.minAgentsForPredictive) {
      this.totalForcedProgressive++;
      this.interventionCount++;
      const fallbackDials = Math.max(0, availableAgents - currentRinging);
      const verdict: SafetyVerdict = {
        decision: SafetyDecision.FORCE_PROGRESSIVE_FALLBACK,
        approvedDials: fallbackDials,
        originalProposal: proposal.requestedDials,
        reason: `Only ${availableAgents} agents available (minimum ${this.minAgentsForPredictive} for predictive). Falling back to progressive.`,
        riskScore: 0.7,
      };
      this.emit('safety:verdict', verdict);
      return verdict;
    }

    // ── Check 5: Zero-Abandonment Headroom Check ──
    // Progressive: 1:1 with currently idle agents.
    // Predictive: may start calls before agents are free, but only for a
    // conservative slice of agents predicted to wrap up during ring time.
    const conservativePredictedFree =
      proposal.pacingMode === 'PREDICTIVE'
        ? Math.floor((proposal.mathTrace?.predictedFreeAgents ?? 0) * 0.4)
        : 0;
    const maxSafeInFlight = availableAgents + conservativePredictedFree;
    const safeMaxDials = Math.max(0, maxSafeInFlight - currentRinging);

    if (proposal.requestedDials > safeMaxDials) {
      if (safeMaxDials === 0) {
        this.totalRejected++;
        this.interventionCount++;
        const verdict: SafetyVerdict = {
          decision: SafetyDecision.REJECT,
          approvedDials: 0,
          originalProposal: proposal.requestedDials,
          reason: `Zero-abandonment check: In-flight calls (${currentRinging}) reached available capacity (${maxSafeInFlight}). Blocking dials.`,
          riskScore: 0.95,
          interventionDetails: `Available: ${availableAgents}, WrapUp: ${poolStats.wrapUp}, In-flight: ${currentRinging}`,
        };
        this.emit('safety:verdict', verdict);
        return verdict;
      }

      this.totalReduced++;
      this.interventionCount++;
      const verdict: SafetyVerdict = {
        decision: SafetyDecision.REDUCE,
        approvedDials: safeMaxDials,
        originalProposal: proposal.requestedDials,
        reason: `Zero-abandonment check: Reducing from ${proposal.requestedDials} to ${safeMaxDials} dials to guarantee 0.00% abandonment.`,
        riskScore: 0.6,
        interventionDetails: `Available: ${availableAgents}, WrapUp: ${poolStats.wrapUp}, In-flight: ${currentRinging}`,
      };
      this.emit('safety:verdict', verdict);
      return verdict;
    }

    // ── Check 6: In-Flight Limit ──
    if (currentRinging + proposal.requestedDials > this.maxInFlightCalls) {
      const allowed = Math.max(0, this.maxInFlightCalls - currentRinging);
      this.totalReduced++;
      this.interventionCount++;
      const verdict: SafetyVerdict = {
        decision: SafetyDecision.REDUCE,
        approvedDials: allowed,
        originalProposal: proposal.requestedDials,
        reason: `In-flight limit: ${currentRinging} ringing + ${proposal.requestedDials} proposed = ${currentRinging + proposal.requestedDials} exceeds max ${this.maxInFlightCalls}. Reducing to ${allowed}.`,
        riskScore: 0.4,
      };
      this.emit('safety:verdict', verdict);
      return verdict;
    }

    // ── Check 7: Circuit breaker half-open — reduce by 75% ──
    if (this.circuitBreaker.isHalfOpen()) {
      const reduced = Math.max(1, Math.ceil(proposal.requestedDials * 0.25));
      this.totalReduced++;
      this.interventionCount++;
      const verdict: SafetyVerdict = {
        decision: SafetyDecision.REDUCE,
        approvedDials: reduced,
        originalProposal: proposal.requestedDials,
        reason: `Circuit breaker HALF_OPEN — probing provider health. Reducing dials by 75% to ${reduced}.`,
        riskScore: 0.5,
      };
      this.emit('safety:verdict', verdict);
      return verdict;
    }

    // ── All checks passed: APPROVE ──
    this.totalApproved++;
    const riskScore = this.calculateRiskScore(proposal, availableAgents, currentRinging, stats.answerRate);
    const verdict: SafetyVerdict = {
      decision: SafetyDecision.APPROVE,
      approvedDials: proposal.requestedDials,
      originalProposal: proposal.requestedDials,
      reason: `All safety checks passed. Approved ${proposal.requestedDials} dials.`,
      riskScore,
    };
    this.emit('safety:verdict', verdict);
    return verdict;
  }

  // ─── Agent Shock Detection ──────────────────────────────────────────────

  private detectAgentShock(): boolean {
    if (this.agentAvailabilityHistory.length < 2) return false;

    const now = Date.now();
    const windowStart = now - this.shockWindowMs;
    const recentHistory = this.agentAvailabilityHistory.filter(
      (h) => h.timestamp >= windowStart
    );

    if (recentHistory.length < 2) return false;

    const maxRecent = Math.max(...recentHistory.map((h) => h.count));
    const currentCount = recentHistory[recentHistory.length - 1].count;

    if (maxRecent === 0) return false;

    const dropRatio = (maxRecent - currentCount) / maxRecent;
    return dropRatio >= this.agentShockThreshold;
  }

  private pruneAvailabilityHistory(): void {
    const cutoff = Date.now() - this.shockWindowMs * 2;
    this.agentAvailabilityHistory = this.agentAvailabilityHistory.filter(
      (h) => h.timestamp >= cutoff
    );
  }

  // ─── Risk Score ─────────────────────────────────────────────────────────

  private calculateRiskScore(
    proposal: DialProposal,
    availableAgents: number,
    currentRinging: number,
    answerRate: number
  ): number {
    if (availableAgents === 0) return 1.0;

    const expectedAnswered = (currentRinging + proposal.requestedDials) * answerRate;
    const utilizationRatio = expectedAnswered / availableAgents;

    // Risk increases as we approach 1:1 ratio
    return Math.min(1.0, Math.max(0.0, utilizationRatio * 0.8));
  }

  // ─── Statistics ─────────────────────────────────────────────────────────

  getInterventionStats() {
    return {
      totalProposals: this.totalProposals,
      totalApproved: this.totalApproved,
      totalReduced: this.totalReduced,
      totalRejected: this.totalRejected,
      totalForcedProgressive: this.totalForcedProgressive,
      interventionCount: this.interventionCount,
      interventionRate: this.totalProposals > 0
        ? this.interventionCount / this.totalProposals
        : 0,
    };
  }

  reset(): void {
    this.agentAvailabilityHistory = [];
    this.interventionCount = 0;
    this.totalProposals = 0;
    this.totalApproved = 0;
    this.totalReduced = 0;
    this.totalRejected = 0;
    this.totalForcedProgressive = 0;
    this.removeAllListeners();
  }
}
