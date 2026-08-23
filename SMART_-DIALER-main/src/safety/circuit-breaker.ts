// ─── Circuit Breaker ────────────────────────────────────────────────────────
import { EventEmitter } from 'events';

/**
 * Circuit Breaker states:
 *   CLOSED   — Normal operation, requests flow through.
 *   OPEN     — Provider unhealthy, all requests blocked.
 *   HALF_OPEN — Probing with reduced traffic to test recovery.
 */
export type CircuitState = 'CLOSED' | 'HALF_OPEN' | 'OPEN';

export interface CircuitBreakerConfig {
  /** Error rate threshold (0.0-1.0) to trip the circuit */
  errorThreshold: number;
  /** P95 latency threshold (ms) to trip the circuit */
  latencyThreshold: number;
  /** Minimum requests before evaluating thresholds */
  minRequestsToEvaluate: number;
  /** Time in ms before OPEN transitions to HALF_OPEN */
  openDurationMs: number;
  /** Number of successful probes in HALF_OPEN before transitioning to CLOSED */
  halfOpenSuccessThreshold: number;
  /** Sliding window size for error/latency tracking */
  windowSize: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  errorThreshold: 0.15,
  latencyThreshold: 5000,
  minRequestsToEvaluate: 10,
  openDurationMs: 30000,
  halfOpenSuccessThreshold: 3,
  windowSize: 50,
};

export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = 'CLOSED';
  private config: CircuitBreakerConfig;

  /** Sliding window of request outcomes */
  private outcomes: { success: boolean; latencyMs: number; timestamp: number }[] = [];
  /** When the circuit was opened */
  private openedAt: number | null = null;
  /** Success count during HALF_OPEN probing */
  private halfOpenSuccessCount: number = 0;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record a request outcome.
   */
  recordOutcome(success: boolean, latencyMs: number): void {
    this.outcomes.push({ success, latencyMs, timestamp: Date.now() });

    // Trim sliding window
    if (this.outcomes.length > this.config.windowSize) {
      this.outcomes.shift();
    }

    if (this.state === 'HALF_OPEN') {
      if (success) {
        this.halfOpenSuccessCount++;
        if (this.halfOpenSuccessCount >= this.config.halfOpenSuccessThreshold) {
          this.transitionTo('CLOSED');
        }
      } else {
        // Failed during probe — back to OPEN
        this.transitionTo('OPEN');
      }
      return;
    }

    if (this.state === 'CLOSED') {
      this.evaluateHealth();
    }
  }

  /**
   * Evaluate current health metrics and trip circuit if thresholds exceeded.
   */
  private evaluateHealth(): void {
    if (this.outcomes.length < this.config.minRequestsToEvaluate) return;

    const errorRate = this.outcomes.filter((o) => !o.success).length / this.outcomes.length;
    const latencies = this.outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
    const p95Index = Math.ceil(latencies.length * 0.95) - 1;
    const p95Latency = latencies[p95Index] || 0;

    if (errorRate > this.config.errorThreshold || p95Latency > this.config.latencyThreshold) {
      this.transitionTo('OPEN');
    }
  }

  /**
   * Check if circuit should transition from OPEN to HALF_OPEN.
   */
  private checkOpenDuration(): void {
    if (
      this.state === 'OPEN' &&
      this.openedAt &&
      Date.now() - this.openedAt >= this.config.openDurationMs
    ) {
      this.transitionTo('HALF_OPEN');
    }
  }

  private transitionTo(newState: CircuitState): void {
    const previousState = this.state;
    this.state = newState;

    if (newState === 'OPEN') {
      this.openedAt = Date.now();
      this.halfOpenSuccessCount = 0;
    } else if (newState === 'HALF_OPEN') {
      this.halfOpenSuccessCount = 0;
    } else if (newState === 'CLOSED') {
      this.openedAt = null;
      this.halfOpenSuccessCount = 0;
      this.outcomes = [];
    }

    this.emit('circuit:transition', { previousState, newState });
  }

  // ─── Query Methods ────────────────────────────────────────────────────

  getState(): CircuitState {
    this.checkOpenDuration();
    return this.state;
  }

  isOpen(): boolean {
    this.checkOpenDuration();
    return this.state === 'OPEN';
  }

  isHalfOpen(): boolean {
    this.checkOpenDuration();
    return this.state === 'HALF_OPEN';
  }

  isClosed(): boolean {
    this.checkOpenDuration();
    return this.state === 'CLOSED';
  }

  getHealthMetrics() {
    const errorRate =
      this.outcomes.length > 0
        ? this.outcomes.filter((o) => !o.success).length / this.outcomes.length
        : 0;
    const latencies = this.outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
    const avgLatency =
      latencies.length > 0
        ? latencies.reduce((s, v) => s + v, 0) / latencies.length
        : 0;
    const p95Index = Math.ceil(latencies.length * 0.95) - 1;
    const p95Latency = latencies[p95Index] || 0;

    return {
      state: this.getState(),
      errorRate,
      avgLatencyMs: avgLatency,
      p95LatencyMs: p95Latency,
      totalRequests: this.outcomes.length,
    };
  }

  reset(): void {
    this.state = 'CLOSED';
    this.outcomes = [];
    this.openedAt = null;
    this.halfOpenSuccessCount = 0;
    this.removeAllListeners();
  }
}
