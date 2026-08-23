// ─── Express Server with SSE for Live Dashboard ────────────────────────────
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { AgentStateMachine } from '../state-machine/agent-state-machine.js';
import { CallStateMachine } from '../state-machine/call-state-machine.js';
import { AgentEvent, AgentState } from '../types/agent.js';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ── Initialize System Components ──
const agentSM = new AgentStateMachine();
const callSM = new CallStateMachine();
const statsCollector = new StatsCollector(0.3, 8000, 120000, 15000);
const circuitBreaker = new CircuitBreaker();
const providerA = new MockProviderA({ answerRate: 0.35, avgTalkTimeMs: 15000, avgRingTimeMs: 3000 });
const providerB = new MockProviderB({ answerRate: 0.35, avgTalkTimeMs: 15000, avgRingTimeMs: 3000 });

let activeProvider = providerA;

const progressiveEngine = new ProgressiveEngine(agentSM, callSM);
const predictiveEngine = new PredictiveEngine(agentSM, callSM, statsCollector);
const safetyController = new SafetyController(agentSM, callSM, statsCollector, circuitBreaker);
const borrowerQueue = new BorrowerQueue();
borrowerQueue.seed(2000, 3);
const allocator = new CallAllocator(
  agentSM, callSM, activeProvider, safetyController, statsCollector,
  circuitBreaker, progressiveEngine, predictiveEngine, borrowerQueue
);
const watchdog = new Watchdog(agentSM, callSM, 5000, 60000, borrowerQueue);

// Create initial agents
const initialAgents = agentSM.createAgents(30, 'Agent');
for (const agent of initialAgents) {
  agentSM.transition(agent.id, AgentEvent.LOGIN, agent.version);
}

// ── Middleware ──
app.use(express.json());
app.use(express.static(path.join(__dirname, '../../web')));

// ── SSE Endpoint for Live Updates ──
const sseClients: express.Response[] = [];

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  sseClients.push(res);

  req.on('close', () => {
    const index = sseClients.indexOf(res);
    if (index !== -1) sseClients.splice(index, 1);
  });
});

function broadcastSSE(event: string, data: any): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

// Broadcast state every second
setInterval(() => {
  broadcastSSE('state', getSystemState());
}, 1000);

function getSystemState() {
  return {
    timestamp: Date.now(),
    agents: agentSM.getPoolStats(),
    calls: callSM.getStats(),
    realtimeStats: statsCollector.getStats(),
    safety: safetyController.getInterventionStats(),
    circuitBreaker: circuitBreaker.getHealthMetrics(),
    watchdog: watchdog.getStats(),
    borrowers: borrowerQueue.getStats(),
    allocator: {
      running: allocator.isRunning(),
      pacingMode: allocator.getPacingMode(),
      activeCallMappings: allocator.getCallAgentMappingSize(),
    },
    providerHealth: activeProvider.getHealth(),
  };
}

// ── REST API ──

// GET /api/state — Full system state
app.get('/api/state', (req, res) => {
  res.json(getSystemState());
});

// GET /api/agents — All agents
app.get('/api/agents', (req, res) => {
  res.json(agentSM.getAllAgents());
});

// POST /api/allocator/start — Start dial cycle
app.post('/api/allocator/start', (req, res) => {
  const { intervalMs, pacingMode } = req.body || {};
  if (pacingMode) allocator.setPacingMode(pacingMode);
  allocator.start(intervalMs || 2000);
  watchdog.start();
  res.json({ status: 'started', pacingMode: allocator.getPacingMode() });
});

// POST /api/allocator/stop — Stop dial cycle
app.post('/api/allocator/stop', (req, res) => {
  allocator.stop();
  watchdog.stop();
  res.json({ status: 'stopped' });
});

// POST /api/allocator/cycle — Execute one manual dial cycle
app.post('/api/allocator/cycle', async (req, res) => {
  try {
    const result = await allocator.executeDiaLCycle();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/pacing — Change pacing mode
app.post('/api/pacing', (req, res) => {
  const { mode } = req.body;
  if (mode === 'PROGRESSIVE' || mode === 'PREDICTIVE') {
    allocator.setPacingMode(mode);
    res.json({ pacingMode: mode });
  } else {
    res.status(400).json({ error: 'Mode must be PROGRESSIVE or PREDICTIVE' });
  }
});

// POST /api/agents/add — Add agents
app.post('/api/agents/add', (req, res) => {
  const { count } = req.body || { count: 5 };
  const newAgents = agentSM.createAgents(count || 5);
  for (const agent of newAgents) {
    agentSM.transition(agent.id, AgentEvent.LOGIN, agent.version);
  }
  res.json({ added: newAgents.length, total: agentSM.getPoolStats().total });
});

// POST /api/agents/drop — Simulate sudden agent drop (across any active state)
app.post('/api/agents/drop', (req, res) => {
  const count = req.body?.count || 10;
  const onlineAgents = agentSM.getAllAgents().filter((a) => a.state !== AgentState.OFFLINE);
  const dropCount = Math.min(count, onlineAgents.length);
  let dropped = 0;

  for (let i = 0; i < dropCount; i++) {
    const a = onlineAgents[i];
    try {
      if (a.state === AgentState.AVAILABLE || a.state === AgentState.PAUSED) {
        agentSM.transition(a.id, AgentEvent.LOGOUT, a.version);
        dropped++;
      } else if (a.state === AgentState.RESERVED || a.state === AgentState.DIALING) {
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

  const pool = agentSM.getPoolStats();
  broadcastSSE('agent-drop', { dropped, remaining: pool.available, total: pool.total });
  res.json({ dropped, remaining: pool.available, totalOnline: pool.total - pool.offline });
});

// POST /api/provider/switch — Switch between providers
app.post('/api/provider/switch', (req, res) => {
  const { provider } = req.body;
  if (provider === 'chaos') {
    res.json({ provider: 'Provider B (Chaos)', status: 'Provider switch requires restart' });
  } else {
    res.json({ provider: 'Provider A (Reliable)', status: 'Provider switch requires restart' });
  }
});

// POST /api/chaos/circuit-trip — Manually trip circuit breaker
app.post('/api/chaos/circuit-trip', (req, res) => {
  // Inject failures to trip the circuit breaker
  for (let i = 0; i < 20; i++) {
    circuitBreaker.recordOutcome(false, 10000);
  }
  res.json({ circuitState: circuitBreaker.getState() });
});

// Serve the dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../web/index.html'));
});

// ── Start Server (only when run directly) ──
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  app.listen(PORT, () => {
    console.log(`\n🚀 SmartDialer Dashboard running at http://localhost:${PORT}`);
    console.log(`   📊 API: http://localhost:${PORT}/api/state`);
    console.log(`   📡 SSE: http://localhost:${PORT}/api/events`);
    console.log(`\n   Agents: ${agentSM.getPoolStats().total} | Mode: ${allocator.getPacingMode()}`);
    console.log(`   Use POST /api/allocator/start to begin dialing\n`);
  });
}

export { app };
