// ─── Real-Time Stats Collector ──────────────────────────────────────────────
/**
 * StatsCollector maintains real-time Exponential Moving Average (EMA)
 * statistics for answer rate, ring time, talk time, and wrap-up time.
 *
 * Uses Bayesian-inspired EMA smoothing to adapt quickly to changing conditions
 * while resisting noise from small sample outliers.
 */

export interface RealtimeStats {
  /** EMA-smoothed answer rate (0.0 - 1.0) */
  answerRate: number;
  /** EMA-smoothed average ring time in ms */
  avgRingTimeMs: number;
  /** EMA-smoothed average talk time in ms */
  avgTalkTimeMs: number;
  /** EMA-smoothed average wrap-up time in ms */
  avgWrapUpTimeMs: number;
  /** Raw counts */
  totalCalls: number;
  totalAnswered: number;
  totalNotAnswered: number;
  /** Windowed answer rate (last N calls) */
  windowedAnswerRate: number;
  /** Timestamp of last update */
  lastUpdatedAt: number;
}

export class StatsCollector {
  // EMA smoothing factors
  private readonly answerRateBeta: number;
  private readonly timeBeta: number;

  // EMA values
  private emaAnswerRate: number;
  private emaRingTime: number;
  private emaTalkTime: number;
  private emaWrapUpTime: number;

  // Raw counters
  private totalCalls: number = 0;
  private totalAnswered: number = 0;
  private totalNotAnswered: number = 0;

  // Sliding window for windowed answer rate
  private readonly windowSize: number;
  private answerWindow: boolean[] = [];

  private lastUpdatedAt: number = Date.now();

  /**
   * @param initialAnswerRate - Prior belief for answer rate (default 0.3)
   * @param initialRingTimeMs - Prior belief for ring time (default 8000ms)
   * @param initialTalkTimeMs - Prior belief for talk time (default 120000ms)
   * @param initialWrapUpTimeMs - Prior belief for wrap-up time (default 15000ms)
   * @param answerRateBeta - EMA smoothing for answer rate (0-1, higher = smoother)
   * @param timeBeta - EMA smoothing for time measurements
   * @param windowSize - Sliding window size for windowed answer rate
   */
  constructor(
    initialAnswerRate: number = 0.3,
    initialRingTimeMs: number = 8000,
    initialTalkTimeMs: number = 120000,
    initialWrapUpTimeMs: number = 15000,
    answerRateBeta: number = 0.85,
    timeBeta: number = 0.9,
    windowSize: number = 50
  ) {
    this.answerRateBeta = answerRateBeta;
    this.timeBeta = timeBeta;
    this.emaAnswerRate = initialAnswerRate;
    this.emaRingTime = initialRingTimeMs;
    this.emaTalkTime = initialTalkTimeMs;
    this.emaWrapUpTime = initialWrapUpTimeMs;
    this.windowSize = windowSize;
  }

  /**
   * Record a call outcome.
   * @param answered - Whether the call was answered
   * @param ringTimeMs - Ring duration in ms
   * @param talkTimeMs - Talk duration in ms (if answered)
   * @param wrapUpTimeMs - Wrap-up duration in ms (if answered)
   */
  recordCallOutcome(
    answered: boolean,
    ringTimeMs: number,
    talkTimeMs?: number,
    wrapUpTimeMs?: number
  ): void {
    this.totalCalls++;

    if (answered) {
      this.totalAnswered++;
    } else {
      this.totalNotAnswered++;
    }

    // Update sliding window
    this.answerWindow.push(answered);
    if (this.answerWindow.length > this.windowSize) {
      this.answerWindow.shift();
    }

    // EMA update for answer rate
    const answerSample = answered ? 1.0 : 0.0;
    this.emaAnswerRate =
      this.answerRateBeta * this.emaAnswerRate +
      (1 - this.answerRateBeta) * answerSample;

    // EMA update for ring time
    if (ringTimeMs > 0) {
      this.emaRingTime =
        this.timeBeta * this.emaRingTime + (1 - this.timeBeta) * ringTimeMs;
    }

    // EMA update for talk time
    if (answered && talkTimeMs !== undefined && talkTimeMs > 0) {
      this.emaTalkTime =
        this.timeBeta * this.emaTalkTime + (1 - this.timeBeta) * talkTimeMs;
    }

    // EMA update for wrap-up time
    if (answered && wrapUpTimeMs !== undefined && wrapUpTimeMs > 0) {
      this.emaWrapUpTime =
        this.timeBeta * this.emaWrapUpTime + (1 - this.timeBeta) * wrapUpTimeMs;
    }

    this.lastUpdatedAt = Date.now();
  }

  /**
   * Get current real-time statistics.
   */
  getStats(): RealtimeStats {
    const windowedAnswerRate =
      this.answerWindow.length > 0
        ? this.answerWindow.filter(Boolean).length / this.answerWindow.length
        : this.emaAnswerRate;

    return {
      answerRate: this.emaAnswerRate,
      avgRingTimeMs: this.emaRingTime,
      avgTalkTimeMs: this.emaTalkTime,
      avgWrapUpTimeMs: this.emaWrapUpTime,
      totalCalls: this.totalCalls,
      totalAnswered: this.totalAnswered,
      totalNotAnswered: this.totalNotAnswered,
      windowedAnswerRate,
      lastUpdatedAt: this.lastUpdatedAt,
    };
  }

  /**
   * Get current EMA answer rate.
   */
  getAnswerRate(): number {
    return this.emaAnswerRate;
  }

  /**
   * Get current EMA ring time.
   */
  getAvgRingTimeMs(): number {
    return this.emaRingTime;
  }

  /**
   * Get current EMA talk time.
   */
  getAvgTalkTimeMs(): number {
    return this.emaTalkTime;
  }

  /**
   * Get worst-case (conservative) answer rate for safety calculations.
   * Uses lower bound estimate: EMA - 1 standard deviation proxy.
   */
  getConservativeAnswerRate(): number {
    // Use windowed rate if enough samples, else use EMA with pessimistic bias
    if (this.answerWindow.length >= 10) {
      const windowed = this.answerWindow.filter(Boolean).length / this.answerWindow.length;
      // Take the higher of EMA and windowed (more conservative = higher answer rate = more risk)
      return Math.max(this.emaAnswerRate, windowed);
    }
    // With few samples, assume worst case (higher answer rate = more potential abandoned)
    return Math.min(this.emaAnswerRate * 1.3, 1.0);
  }

  /**
   * Reset all statistics.
   */
  reset(): void {
    this.totalCalls = 0;
    this.totalAnswered = 0;
    this.totalNotAnswered = 0;
    this.answerWindow = [];
    this.lastUpdatedAt = Date.now();
  }
}
