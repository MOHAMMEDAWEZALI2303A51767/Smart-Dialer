// ─── Dialer Simulator ───────────────────────────────────────────────────────
import { AgentStateMachine } from '../state-machine/agent-state-machine.js';
import { CallStateMachine } from '../state-machine/call-state-machine.js';
import { AgentState, AgentEvent } from '../types/agent.js';
import { CallState, CallEvent, CallDisposition, SafetyDecision } from '../types/call.js';
import { StatsCollector } from '../pacing/stats-collector.js';
import { ProgressiveEngine } from '../pacing/progressive-engine.js';
import { PredictiveEngine } from '../pacing/predictive-engine.js';
import { SafetyController } from '../safety/safety-controller.js';
import { CircuitBreaker } from '../safety/circuit-breaker.js';
import { CallAllocator } from '../allocator/call-allocator.js';
import { Watchdog } from '../allocator/watchdog.js';
import { MockProviderA } from '../providers/mock-provider-a.js';
import { MockProviderB } from '../providers/mock-provider-b.js';
import { BorrowerQueue } from '../allocator/borrower-queue.js';

export interface ScenarioConfig {
  name: string;
  description: string;
  agentCount: number;
  answerRate: number;
  avgTalkTimeMs: number;
  avgRingTimeMs: number;
  durationMs: number;
  pacingMode: 'PROGRESSIVE' | 'PREDICTIVE';
  useChaosProvider: boolean;
  timeScaleFactor?: number;
  dynamicEvents?: DynamicEvent[];
}

export interface DynamicEvent {
  atMs: number;
  type: 'AGENT_DROP' | 'ANSWER_RATE_CHANGE' | 'PROVIDER_SPIKE' | 'AGENT_ADD';
  agentCount?: number;
  newAnswerRate?: number;
}

export interface SimulationResult {
  scenario: string;
  pacingMode: string;
  durationMs: number;
  agentCount: number;
  totalCallsInitiated: number;
  totalCallsAnswered: number;
  totalCallsNoAnswer: number;
  totalCallsFailed: number;
  totalCallsAbandoned: number;
  answerRate: number;
  abandonmentRate: number;
  connectionRate: number;
  agentUtilization: number;
  safetyInterventions: number;
  safetyInterventionRate: number;
  forcedProgressiveFallbacks: number;
  providerErrorRate: number;
  avgLatencyMs: number;
  agentsReclaimed: number;
  callsRecovered: number;
}

/**
 * Pre-defined simulation scenarios from the assignment (Page 6).
 * Times are scaled by 20x for responsive local simulation while preserving exact statistics.
 */
const TIME_SCALE = 20; // 20x speed: 120s real talk time = 6s simulated talk time

export const SCENARIOS: Record<string, ScenarioConfig> = {
  A: {
    name: 'Scenario A',
    description: '20% Answer Rate, 120s Real Talk Time — Low connectivity, aggressive pacing',
    agentCount: 30,
    answerRate: 0.20,
    avgTalkTimeMs: 120_000 / TIME_SCALE, // 6,000ms simulated
    avgRingTimeMs: 8000 / TIME_SCALE,    // 400ms simulated
    durationMs: 12_000,
    pacingMode: 'PREDICTIVE',
    useChaosProvider: false,
    timeScaleFactor: TIME_SCALE,
  },
  B: {
    name: 'Scenario B',
    description: '50% Answer Rate, 90s Real Talk Time — Medium connectivity, balanced pacing',
    agentCount: 30,
    answerRate: 0.50,
    avgTalkTimeMs: 90_000 / TIME_SCALE,  // 4,500ms simulated
    avgRingTimeMs: 6000 / TIME_SCALE,    // 300ms simulated
    durationMs: 12_000,
    pacingMode: 'PREDICTIVE',
    useChaosProvider: false,
    timeScaleFactor: TIME_SCALE,
  },
  C: {
    name: 'Scenario C',
    description: '70% Answer Rate, 180s Real Talk Time — High connectivity, high risk of abandonment',
    agentCount: 30,
    answerRate: 0.70,
    avgTalkTimeMs: 180_000 / TIME_SCALE, // 9,000ms simulated
    avgRingTimeMs: 5000 / TIME_SCALE,    // 250ms simulated
    durationMs: 12_000,
    pacingMode: 'PREDICTIVE',
    useChaosProvider: false,
    timeScaleFactor: TIME_SCALE,
  },
  D: {
    name: 'Scenario D',
    description: 'Dynamic — Chaos provider + 40% agent sudden drop + answer rate shifts',
    agentCount: 30,
    answerRate: 0.40,
    avgTalkTimeMs: 120_000 / TIME_SCALE,
    avgRingTimeMs: 6000 / TIME_SCALE,
    durationMs: 15_000,
    pacingMode: 'PREDICTIVE',
    useChaosProvider: true,
    timeScaleFactor: TIME_SCALE,
    dynamicEvents: [
      { atMs: 3000, type: 'AGENT_DROP', agentCount: 12 },          // 40% sudden agent drop
      { atMs: 6000, type: 'ANSWER_RATE_CHANGE', newAnswerRate: 0.15 }, // Sharp answer rate drop
      { atMs: 9000, type: 'AGENT_ADD', agentCount: 10 },           // Agents return
      { atMs: 11000, type: 'ANSWER_RATE_CHANGE', newAnswerRate: 0.65 },// Sudden answer rate surge
    ],
  },
};

export async function runSimulation(config: ScenarioConfig): Promise<SimulationResult> {
  const agentSM = new AgentStateMachine();
  const callSM = new CallStateMachine();
  const statsCollector = new StatsCollector(config.answerRate, config.avgRingTimeMs);
  const circuitBreaker = new CircuitBreaker();

  const provider = config.useChaosProvider
    ? new MockProviderB({
        answerRate: config.answerRate,
        avgRingTimeMs: config.avgRingTimeMs,
        avgTalkTimeMs: config.avgTalkTimeMs,
        latencyRange: [50, 200],
      })
    : new MockProviderA({
        answerRate: config.answerRate,
        avgRingTimeMs: config.avgRingTimeMs,
        avgTalkTimeMs: config.avgTalkTimeMs,
        latencyRange: [10, 50],
      });

  const progressiveEngine = new ProgressiveEngine(agentSM, callSM);
  const predictiveEngine = new PredictiveEngine(agentSM, callSM, statsCollector);

  const safetyController = new SafetyController(
    agentSM,
    callSM,
    statsCollector,
    circuitBreaker,
    { maxAbandonmentRate: 0.0, agentShockThreshold: 0.25 }
  );

  const borrowerQueue = new BorrowerQueue();
  borrowerQueue.seed(2000, 3);

  const allocator = new CallAllocator(
    agentSM,
    callSM,
    provider,
    safetyController,
    statsCollector,
    circuitBreaker,
    progressiveEngine,
    predictiveEngine,
    borrowerQueue
  );
  allocator.setWrapUpDurationMs(600); // 600ms simulated wrap-up

  const watchdog = new Watchdog(agentSM, callSM, 2000, 10000, borrowerQueue);

  // ── Create and activate agents ──
  const agents = agentSM.createAgents(config.agentCount);
  for (const agent of agents) {
    agentSM.transition(agent.id, AgentEvent.LOGIN, agent.version);
  }

  // ── Schedule dynamic events ──
  const eventTimers: NodeJS.Timeout[] = [];
  if (config.dynamicEvents) {
    for (const event of config.dynamicEvents) {
      const timer = setTimeout(() => {
        switch (event.type) {
          case 'AGENT_DROP': {
            const online = agentSM.getAllAgents().filter((a) => a.state !== AgentState.OFFLINE);
            const dropCount = Math.min(event.agentCount || 0, online.length);
            let dropped = 0;
            for (let i = 0; i < dropCount; i++) {
              const a = online[i];
              try {
                if (a.state === AgentState.AVAILABLE || a.state === AgentState.PAUSED) {
                  agentSM.transition(a.id, AgentEvent.LOGOUT, a.version);
                  dropped++;
                } else {
                  agentSM.forceRelease(a.id);
                  const fresh = agentSM.getAgent(a.id);
                  if (fresh && fresh.state === AgentState.AVAILABLE) {
                    agentSM.transition(fresh.id, AgentEvent.LOGOUT, fresh.version);
                  }
                  dropped++;
                }
              } catch {}
            }
            console.log(`  ⚡ Dynamic Event: ${dropped} agents suddenly logged out at ${event.atMs}ms`);
            break;
          }
          case 'AGENT_ADD': {
            const newAgents = agentSM.createAgents(event.agentCount || 0);
            for (const a of newAgents) {
              agentSM.transition(a.id, AgentEvent.LOGIN, a.version);
            }
            console.log(`  ⚡ Dynamic Event: ${event.agentCount} agents logged in at ${event.atMs}ms`);
            break;
          }
          case 'ANSWER_RATE_CHANGE': {
            if (event.newAnswerRate !== undefined) {
              if ('updateConfig' in provider) {
                (provider as any).updateConfig({ answerRate: event.newAnswerRate });
              }
              console.log(`  ⚡ Dynamic Event: Answer rate shifted to ${(event.newAnswerRate * 100).toFixed(0)}% at ${event.atMs}ms`);
            }
            break;
          }
        }
      }, event.atMs);
      eventTimers.push(timer);
    }
  }

  // ── Start simulation ──
  allocator.setPacingMode(config.pacingMode);
  allocator.start(250); // Dial loop every 250ms
  watchdog.start();

  console.log(`\n🚀 Starting ${config.name}: ${config.description}`);
  console.log(`   Agents: ${config.agentCount} | Mode: ${config.pacingMode} | Provider: ${config.useChaosProvider ? 'Chaos' : 'Reliable'}`);

  // ── Track agent utilization over time ──
  let utilizationSamples: number[] = [];
  const sampleInterval = setInterval(() => {
    const pool = agentSM.getPoolStats();
    const active = pool.connected + pool.dialing + pool.wrapUp;
    const total = pool.total - pool.offline;
    if (total > 0) {
      utilizationSamples.push(active / total);
    }
  }, 100);

  // Wait for simulation duration
  await new Promise<void>((resolve) => setTimeout(resolve, config.durationMs));

  clearInterval(sampleInterval);
  allocator.stop();
  watchdog.stop();
  eventTimers.forEach((t) => clearTimeout(t));

  // Wait briefly for in-flight requests to complete
  await new Promise<void>((resolve) => setTimeout(resolve, 1000));

  const callStats = callSM.getStats();
  const poolStats = agentSM.getPoolStats();
  const safetyStats = safetyController.getInterventionStats();
  const watchdogStats = watchdog.getStats();
  const providerHealth = provider.getHealth();

  const avgUtilization =
    utilizationSamples.length > 0
      ? utilizationSamples.reduce((s, v) => s + v, 0) / utilizationSamples.length
      : 0;

  const result: SimulationResult = {
    scenario: config.name,
    pacingMode: config.pacingMode,
    durationMs: config.durationMs,
    agentCount: config.agentCount,
    totalCallsInitiated: callStats.totalInitiated,
    totalCallsAnswered: callStats.totalAnswered,
    totalCallsNoAnswer: callStats.totalNoAnswer,
    totalCallsFailed: callStats.totalFailed,
    totalCallsAbandoned: callStats.totalAbandoned,
    answerRate: callStats.answerRate,
    abandonmentRate: callStats.abandonmentRate,
    connectionRate: callStats.totalInitiated > 0
      ? callStats.totalAnswered / callStats.totalInitiated
      : 0,
    agentUtilization: avgUtilization,
    safetyInterventions: safetyStats.interventionCount,
    safetyInterventionRate: safetyStats.interventionRate,
    forcedProgressiveFallbacks: safetyStats.totalForcedProgressive,
    providerErrorRate: 1 - providerHealth.successRate,
    avgLatencyMs: providerHealth.avgLatencyMs,
    agentsReclaimed: watchdogStats.totalAgentsReclaimed,
    callsRecovered: watchdogStats.totalCallsRecovered,
  };

  printResults(result);

  provider.reset();
  agentSM.reset();
  callSM.reset();
  statsCollector.reset();
  circuitBreaker.reset();
  safetyController.reset();
  watchdog.reset();

  return result;
}

function printResults(result: SimulationResult): void {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  📊 ${result.scenario} Results (${result.pacingMode})`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  📞 Calls Initiated:      ${result.totalCallsInitiated}`);
  console.log(`  ✅ Calls Answered:       ${result.totalCallsAnswered}`);
  console.log(`  ❌ Calls No-Answer:      ${result.totalCallsNoAnswer}`);
  console.log(`  💥 Calls Failed:         ${result.totalCallsFailed}`);
  console.log(`  🚨 Calls ABANDONED:      ${result.totalCallsAbandoned} ${result.totalCallsAbandoned === 0 ? '✅ ZERO (Compliant)' : '⛔ VIOLATION!'}`);
  console.log(`  ─────────────────────────────────────────────────`);
  console.log(`  📈 Answer Rate:          ${(result.answerRate * 100).toFixed(1)}%`);
  console.log(`  🔴 Abandonment Rate:     ${(result.abandonmentRate * 100).toFixed(2)}% ${result.abandonmentRate === 0 ? '✅ 0.00%' : '⛔'}`);
  console.log(`  🔗 Connection Rate:      ${(result.connectionRate * 100).toFixed(1)}%`);
  console.log(`  👤 Agent Utilization:    ${(result.agentUtilization * 100).toFixed(1)}%`);
  console.log(`  ─────────────────────────────────────────────────`);
  console.log(`  🛡️  Safety Interventions: ${result.safetyInterventions} (${(result.safetyInterventionRate * 100).toFixed(1)}%)`);
  console.log(`  ↩️  Progressive Fallbacks: ${result.forcedProgressiveFallbacks}`);
  console.log(`  🔧 Agents Reclaimed:     ${result.agentsReclaimed} (by watchdog)`);
  console.log(`  🔧 Calls Recovered:      ${result.callsRecovered} (by watchdog)`);
  console.log(`  📡 Provider Error Rate:  ${(result.providerErrorRate * 100).toFixed(1)}%`);
  console.log(`  ⏱️  Provider Avg Latency: ${result.avgLatencyMs.toFixed(0)}ms`);
  console.log(`${'═'.repeat(70)}\n`);
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║              SmartDialer Simulation Suite                           ║');
  console.log('║    Testing Progressive & Predictive Pacing with Safety Controller   ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  const results: SimulationResult[] = [];

  for (const key of ['A', 'B', 'C', 'D'] as const) {
    const config = SCENARIOS[key];
    const result = await runSimulation(config);
    results.push(result);
  }

  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║                    SIMULATION SUMMARY TABLE                         ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('┌──────────────┬────────────┬────────────┬───────────────┬──────────────┐');
  console.log('│ Scenario     │ Answer %   │ Abandon %  │ Utilization % │ Interventions│');
  console.log('├──────────────┼────────────┼────────────┼───────────────┼──────────────┤');

  for (const r of results) {
    console.log(
      `│ ${r.scenario.padEnd(12)} │ ${(r.answerRate * 100).toFixed(1).padStart(8)}%  │ ${(r.abandonmentRate * 100).toFixed(2).padStart(8)}%  │ ${(r.agentUtilization * 100).toFixed(1).padStart(11)}%  │ ${String(r.safetyInterventions).padStart(12)} │`
    );
  }

  console.log('└──────────────┴────────────┴────────────┴───────────────┴──────────────┘');

  const allZeroAbandonment = results.every((r) => r.totalCallsAbandoned === 0);
  console.log(
    `\n${allZeroAbandonment
      ? '✅ ALL SCENARIOS PASSED: Zero abandoned calls (0.00%) maintained across all scenarios!'
      : '⛔ FAILURE: Some scenarios had abandoned calls — safety controller needs tuning.'
    }`
  );

  process.exit(0);
}

main().catch((err) => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
