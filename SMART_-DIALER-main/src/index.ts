// ─── SmartDialer Main Entry Point ────────────────────────────────────────────
export { AgentStateMachine, ConcurrencyConflictError, InvalidTransitionError } from './state-machine/agent-state-machine.js';
export { CallStateMachine } from './state-machine/call-state-machine.js';
export { ProgressiveEngine } from './pacing/progressive-engine.js';
export { PredictiveEngine } from './pacing/predictive-engine.js';
export { StatsCollector } from './pacing/stats-collector.js';
export { SafetyController } from './safety/safety-controller.js';
export { CircuitBreaker } from './safety/circuit-breaker.js';
export { MockProviderA } from './providers/mock-provider-a.js';
export { MockProviderB } from './providers/mock-provider-b.js';
export { CallAllocator } from './allocator/call-allocator.js';
export { Watchdog } from './allocator/watchdog.js';
export { BorrowerQueue, BorrowerClaimConflictError } from './allocator/borrower-queue.js';
export * from './types/agent.js';
export * from './types/call.js';
export * from './types/provider.js';

console.log('SmartDialer — Production-Grade Predictive Dialer Prototype');
console.log('Use: npm run simulate | npm run loadtest | npm run dashboard');
