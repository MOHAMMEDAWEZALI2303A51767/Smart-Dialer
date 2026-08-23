// ─── Mock Provider A (Fast, Reliable) ───────────────────────────────────────
import {
  ITelecomProvider,
  CallInitResult,
  ProviderHealthStatus,
  ProviderHealthState,
  ProviderEventCallback,
  MockProviderConfig,
} from '../types/provider.js';
import { CallEvent } from '../types/call.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * MockProviderA simulates a fast, highly reliable telecom provider.
 *
 * Characteristics:
 * - Low latency: 50-150ms
 * - High success rate: ~99.8%
 * - Strict in-order event delivery
 * - No duplicate events
 * - Configurable answer rate
 */
export class MockProviderA implements ITelecomProvider {
  readonly providerId: string;
  readonly name: string;
  private config: MockProviderConfig;
  private eventCallbacks: ProviderEventCallback[] = [];
  private requestCount: number = 0;
  private errorCount: number = 0;
  private latencies: number[] = [];
  private activeCalls: Map<string, NodeJS.Timeout[]> = new Map();
  private initiatedCallIds: Set<string> = new Set();
  private outage: boolean = false;

  constructor(config?: Partial<MockProviderConfig>) {
    this.config = {
      providerId: 'provider-a',
      name: 'Provider A (Reliable)',
      latencyRange: [50, 150],
      answerRate: 0.3,
      avgRingTimeMs: 6000,
      avgTalkTimeMs: 120000,
      failureRate: 0.002,
      duplicateEventRate: 0,
      outOfOrderRate: 0,
      timeoutRate: 0.001,
      latencySpikeRate: 0.01,
      latencySpikeMultiplier: 3,
      ...config,
    };
    this.providerId = this.config.providerId;
    this.name = this.config.name;
  }

  async initiateCall(callId: string, phoneNumber: string): Promise<CallInitResult> {
    this.requestCount++;
    const startTime = Date.now();

    if (this.initiatedCallIds.has(callId)) {
      return {
        success: true,
        callId,
        providerId: this.providerId,
        providerCallRef: `prov-a-dup-${callId.slice(0, 8)}`,
        latencyMs: 0,
      };
    }

    if (this.outage) {
      this.errorCount++;
      return {
        success: false,
        callId,
        providerId: this.providerId,
        error: 'Provider A: OUTAGE — new calls rejected',
        latencyMs: Date.now() - startTime,
      };
    }

    // Simulate latency
    let latency = this.randomInRange(this.config.latencyRange[0], this.config.latencyRange[1]);
    if (Math.random() < this.config.latencySpikeRate) {
      latency *= this.config.latencySpikeMultiplier;
    }

    await this.delay(latency);
    this.latencies.push(latency);

    // Simulate failure
    if (Math.random() < this.config.failureRate) {
      this.errorCount++;
      return {
        success: false,
        callId,
        providerId: this.providerId,
        error: 'Provider A: Call initiation failed (simulated)',
        latencyMs: Date.now() - startTime,
      };
    }

    // Simulate timeout
    if (Math.random() < this.config.timeoutRate) {
      this.errorCount++;
      return {
        success: false,
        callId,
        providerId: this.providerId,
        error: 'Provider A: Request timed out (simulated)',
        latencyMs: Date.now() - startTime,
      };
    }

    this.initiatedCallIds.add(callId);

    // Success — schedule lifecycle events
    this.scheduleCallLifecycle(callId, phoneNumber);

    return {
      success: true,
      callId,
      providerId: this.providerId,
      providerCallRef: `prov-a-${uuidv4().slice(0, 8)}`,
      latencyMs: Date.now() - startTime,
    };
  }

  async cancelCall(callId: string): Promise<boolean> {
    const timers = this.activeCalls.get(callId);
    if (timers) {
      timers.forEach((t) => clearTimeout(t));
      this.activeCalls.delete(callId);

      // Emit cancel event
      this.emitEvent({
        eventId: uuidv4(),
        callId,
        eventType: 'CANCEL',
        timestamp: Date.now(),
        providerId: this.providerId,
      });
      return true;
    }
    return false;
  }

  getHealth(): ProviderHealthStatus {
    const sortedLatencies = [...this.latencies].sort((a, b) => a - b);
    const p95Index = Math.ceil(sortedLatencies.length * 0.95) - 1;

    return {
      providerId: this.providerId,
      state: this.errorCount / Math.max(this.requestCount, 1) < 0.05
        ? ProviderHealthState.HEALTHY
        : ProviderHealthState.DEGRADED,
      successRate: this.requestCount > 0
        ? (this.requestCount - this.errorCount) / this.requestCount
        : 1,
      avgLatencyMs: this.latencies.length > 0
        ? this.latencies.reduce((s, v) => s + v, 0) / this.latencies.length
        : 0,
      p95LatencyMs: sortedLatencies[p95Index] || 0,
      errorCount: this.errorCount,
      totalRequests: this.requestCount,
      lastCheckedAt: Date.now(),
      circuitState: 'CLOSED',
    };
  }

  onEvent(callback: ProviderEventCallback): void {
    this.eventCallbacks.push(callback);
  }

  reset(): void {
    // Clear all pending timers
    for (const timers of this.activeCalls.values()) {
      timers.forEach((t) => clearTimeout(t));
    }
    this.activeCalls.clear();
    this.requestCount = 0;
    this.errorCount = 0;
    this.latencies = [];
    this.eventCallbacks = [];
    this.initiatedCallIds.clear();
    this.outage = false;
  }

  setOutage(outage: boolean): void {
    this.outage = outage;
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  private scheduleCallLifecycle(callId: string, phoneNumber: string): void {
    const timers: NodeJS.Timeout[] = [];
    const answered = Math.random() < this.config.answerRate;

    // Ring event after short delay
    const ringDelay = this.randomInRange(200, 500);
    timers.push(
      setTimeout(() => {
        this.emitEvent({
          eventId: uuidv4(),
          callId,
          eventType: 'RING',
          timestamp: Date.now(),
          providerId: this.providerId,
        });
      }, ringDelay)
    );

    if (answered) {
      // Answer event after ring time
      const ringTime = this.gaussianRandom(this.config.avgRingTimeMs, this.config.avgRingTimeMs * 0.3);
      timers.push(
        setTimeout(() => {
          this.emitEvent({
            eventId: uuidv4(),
            callId,
            eventType: 'ANSWER',
            timestamp: Date.now(),
            providerId: this.providerId,
          });

          // Complete event after talk time
          const talkTime = this.gaussianRandom(this.config.avgTalkTimeMs, this.config.avgTalkTimeMs * 0.3);
          const completeTimer = setTimeout(() => {
            this.emitEvent({
              eventId: uuidv4(),
              callId,
              eventType: 'COMPLETE',
              timestamp: Date.now(),
              providerId: this.providerId,
            });
            this.activeCalls.delete(callId);
          }, talkTime);
          timers.push(completeTimer);
        }, ringDelay + ringTime)
      );
    } else {
      // No answer — complete after ring timeout
      const ringTimeout = this.gaussianRandom(this.config.avgRingTimeMs * 1.5, this.config.avgRingTimeMs * 0.3);
      timers.push(
        setTimeout(() => {
          this.emitEvent({
            eventId: uuidv4(),
            callId,
            eventType: 'NO_ANSWER',
            timestamp: Date.now(),
            providerId: this.providerId,
          });
          this.activeCalls.delete(callId);
        }, ringDelay + ringTimeout)
      );
    }

    this.activeCalls.set(callId, timers);
  }

  private emitEvent(event: {
    eventId: string;
    callId: string;
    eventType: string;
    timestamp: number;
    providerId: string;
  }): void {
    for (const callback of this.eventCallbacks) {
      callback(event);
    }
  }

  private randomInRange(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private gaussianRandom(mean: number, stdDev: number): number {
    // Box-Muller transform for Gaussian distribution
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(100, Math.round(mean + z * stdDev));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Update provider config dynamically (for simulation scenarios).
   */
  updateConfig(updates: Partial<MockProviderConfig>): void {
    Object.assign(this.config, updates);
  }
}
