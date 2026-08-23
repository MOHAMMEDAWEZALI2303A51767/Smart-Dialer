// ─── Telecom Provider Types & Interfaces ────────────────────────────────────

/**
 * Result of a call initiation request to a telecom provider.
 */
export interface CallInitResult {
  success: boolean;
  callId: string;
  providerId: string;
  /** Provider-side call reference */
  providerCallRef?: string;
  error?: string;
  latencyMs: number;
}

/**
 * Provider health status.
 */
export enum ProviderHealthState {
  HEALTHY = 'HEALTHY',
  DEGRADED = 'DEGRADED',
  UNHEALTHY = 'UNHEALTHY',
}

export interface ProviderHealthStatus {
  providerId: string;
  state: ProviderHealthState;
  successRate: number;        // 0.0 - 1.0
  avgLatencyMs: number;
  p95LatencyMs: number;
  errorCount: number;
  totalRequests: number;
  lastCheckedAt: number;
  circuitState: 'CLOSED' | 'HALF_OPEN' | 'OPEN';
}

/**
 * Callback handler for provider events (webhooks).
 */
export type ProviderEventCallback = (event: ProviderCallEventFromProvider) => void;

/**
 * Provider-side call event (raw from provider, before normalization).
 */
export interface ProviderCallEventFromProvider {
  eventId: string;
  callId: string;
  eventType: string;       // Provider-specific event type string
  timestamp: number;
  providerId: string;
  rawData?: Record<string, unknown>;
}

/**
 * Telecom Provider interface — contract for all providers.
 */
export interface ITelecomProvider {
  readonly providerId: string;
  readonly name: string;

  /**
   * Initiate a call to the given phone number.
   * Returns a CallInitResult with success/failure and latency info.
   */
  initiateCall(callId: string, phoneNumber: string): Promise<CallInitResult>;

  /**
   * Cancel an in-progress call.
   */
  cancelCall(callId: string): Promise<boolean>;

  /**
   * Get current provider health status.
   */
  getHealth(): ProviderHealthStatus;

  /**
   * Register a callback for provider call events (webhooks).
   */
  onEvent(callback: ProviderEventCallback): void;

  /**
   * Reset provider state (for testing).
   */
  reset(): void;

  /**
   * Simulate a provider outage. New initiates fail; in-flight calls keep running.
   */
  setOutage?(outage: boolean): void;
}

/**
 * Configuration for mock provider behavior.
 */
export interface MockProviderConfig {
  providerId: string;
  name: string;
  /** Base latency range [min, max] in ms */
  latencyRange: [number, number];
  /** Probability of call being answered (0.0 - 1.0) */
  answerRate: number;
  /** Average ring time in ms before answer/no-answer */
  avgRingTimeMs: number;
  /** Average talk time in ms once connected */
  avgTalkTimeMs: number;
  /** Failure rate (0.0 - 1.0) — proportion of initiate calls that fail */
  failureRate: number;
  /** Duplicate event rate (0.0 - 1.0) — chance of sending duplicate webhooks */
  duplicateEventRate: number;
  /** Out-of-order event rate (0.0 - 1.0) — chance of shuffling event order */
  outOfOrderRate: number;
  /** Timeout rate (0.0 - 1.0) — chance of call timing out with no response */
  timeoutRate: number;
  /** Latency spike probability (0.0 - 1.0) */
  latencySpikeRate: number;
  /** Latency spike multiplier */
  latencySpikeMultiplier: number;
}
