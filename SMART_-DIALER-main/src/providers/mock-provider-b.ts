// ─── Mock Provider B (Chaos / Degraded) ─────────────────────────────────────
import {
  ITelecomProvider,
  CallInitResult,
  ProviderHealthStatus,
  ProviderHealthState,
  ProviderEventCallback,
  MockProviderConfig,
} from '../types/provider.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * MockProviderB simulates a degraded, unreliable telecom provider.
 *
 * Chaos characteristics:
 * - High latency: 200-2000ms with jitter
 * - Latency spikes: 20% chance of 3-5x multiplier
 * - Duplicate webhooks: 15% of events sent 2-3 times
 * - Out-of-order events: 10% chance of shuffling event order
 * - Failure rate: 8% of call initiations fail
 * - Timeout rate: 5% of calls time out with no response
 *
 * This provider exercises the system's:
 * - Idempotent event processing (deduplication)
 * - Out-of-order state machine reconciliation
 * - Circuit breaker health monitoring
 * - Safety controller provider health checks
 */
export class MockProviderB implements ITelecomProvider {
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
      providerId: 'provider-b',
      name: 'Provider B (Chaos)',
      latencyRange: [200, 2000],
      answerRate: 0.3,
      avgRingTimeMs: 8000,
      avgTalkTimeMs: 120000,
      failureRate: 0.08,
      duplicateEventRate: 0.15,
      outOfOrderRate: 0.10,
      timeoutRate: 0.05,
      latencySpikeRate: 0.20,
      latencySpikeMultiplier: 4,
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
        providerCallRef: `prov-b-dup-${callId.slice(0, 8)}`,
        latencyMs: 0,
      };
    }

    if (this.outage) {
      this.errorCount++;
      return {
        success: false,
        callId,
        providerId: this.providerId,
        error: 'Provider B: OUTAGE — new calls rejected',
        latencyMs: Date.now() - startTime,
      };
    }

    // Simulate high/jittery latency
    let latency = this.randomInRange(this.config.latencyRange[0], this.config.latencyRange[1]);
    if (Math.random() < this.config.latencySpikeRate) {
      latency *= this.randomInRange(
        Math.floor(this.config.latencySpikeMultiplier * 0.5),
        this.config.latencySpikeMultiplier
      );
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
        error: 'Provider B: Call initiation failed — network error (simulated)',
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
        error: 'Provider B: Request timed out — no response (simulated)',
        latencyMs: Date.now() - startTime,
      };
    }

    this.initiatedCallIds.add(callId);

    // Success — schedule chaotic lifecycle events
    this.scheduleChaosCallLifecycle(callId, phoneNumber);

    return {
      success: true,
      callId,
      providerId: this.providerId,
      providerCallRef: `prov-b-${uuidv4().slice(0, 8)}`,
      latencyMs: Date.now() - startTime,
    };
  }

  async cancelCall(callId: string): Promise<boolean> {
    const timers = this.activeCalls.get(callId);
    if (timers) {
      timers.forEach((t) => clearTimeout(t));
      this.activeCalls.delete(callId);

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
    const errorRate = this.requestCount > 0
      ? this.errorCount / this.requestCount
      : 0;

    let state: ProviderHealthState;
    if (errorRate > 0.15) {
      state = ProviderHealthState.UNHEALTHY;
    } else if (errorRate > 0.05) {
      state = ProviderHealthState.DEGRADED;
    } else {
      state = ProviderHealthState.HEALTHY;
    }

    return {
      providerId: this.providerId,
      state,
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

  // ─── Chaos Event Scheduling ───────────────────────────────────────────

  private scheduleChaosCallLifecycle(callId: string, phoneNumber: string): void {
    const timers: NodeJS.Timeout[] = [];
    const answered = Math.random() < this.config.answerRate;

    // Build the event sequence
    const events: { eventType: string; delayMs: number; eventId: string }[] = [];

    // Ring event
    const ringDelay = this.randomInRange(300, 800);
    events.push({
      eventType: 'RING',
      delayMs: ringDelay,
      eventId: uuidv4(),
    });

    if (answered) {
      const ringTime = this.gaussianRandom(this.config.avgRingTimeMs, this.config.avgRingTimeMs * 0.4);
      events.push({
        eventType: 'ANSWER',
        delayMs: ringDelay + ringTime,
        eventId: uuidv4(),
      });

      const talkTime = this.gaussianRandom(this.config.avgTalkTimeMs, this.config.avgTalkTimeMs * 0.4);
      events.push({
        eventType: 'COMPLETE',
        delayMs: ringDelay + ringTime + talkTime,
        eventId: uuidv4(),
      });
    } else {
      const ringTimeout = this.gaussianRandom(this.config.avgRingTimeMs * 1.5, this.config.avgRingTimeMs * 0.4);
      events.push({
        eventType: 'NO_ANSWER',
        delayMs: ringDelay + ringTimeout,
        eventId: uuidv4(),
      });
    }

    // ── CHAOS: Out-of-order event delivery ──
    let orderedEvents = [...events];
    if (Math.random() < this.config.outOfOrderRate && events.length >= 2) {
      // Shuffle non-first events (keep ring first but shuffle answer/complete)
      const tail = orderedEvents.slice(1);
      for (let i = tail.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tail[i], tail[j]] = [tail[j], tail[i]];
      }
      orderedEvents = [orderedEvents[0], ...tail];
    }

    // Schedule events
    for (const evt of orderedEvents) {
      const timer = setTimeout(() => {
        this.emitEvent({
          eventId: evt.eventId,
          callId,
          eventType: evt.eventType,
          timestamp: Date.now(),
          providerId: this.providerId,
        });

        // ── CHAOS: Duplicate event delivery ──
        if (Math.random() < this.config.duplicateEventRate) {
          // Send the same event again after a small delay
          const dupTimer = setTimeout(() => {
            this.emitEvent({
              eventId: evt.eventId,    // Same eventId = duplicate
              callId,
              eventType: evt.eventType,
              timestamp: Date.now(),
              providerId: this.providerId,
            });
          }, this.randomInRange(10, 200));
          timers.push(dupTimer);

          // Occasionally triple-send
          if (Math.random() < 0.3) {
            const tripTimer = setTimeout(() => {
              this.emitEvent({
                eventId: evt.eventId,
                callId,
                eventType: evt.eventType,
                timestamp: Date.now(),
                providerId: this.providerId,
              });
            }, this.randomInRange(50, 500));
            timers.push(tripTimer);
          }
        }
      }, evt.delayMs);
      timers.push(timer);
    }

    this.activeCalls.set(callId, timers);

    // Auto-cleanup after max duration
    const cleanupTimer = setTimeout(() => {
      this.activeCalls.delete(callId);
    }, (this.config.avgTalkTimeMs + this.config.avgRingTimeMs) * 3);
    timers.push(cleanupTimer);
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
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(100, Math.round(mean + z * stdDev));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  updateConfig(updates: Partial<MockProviderConfig>): void {
    Object.assign(this.config, updates);
  }
}
