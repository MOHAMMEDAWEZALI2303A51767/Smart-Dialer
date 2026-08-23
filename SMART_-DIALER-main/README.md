# 📞 SmartDialer — Production-Grade Predictive & Progressive Dialer

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org/)
[![Vitest](https://img.shields.io/badge/Tests-55%20Passed-brightgreen.svg)](https://vitest.dev/)
[![Zero-Abandonment](https://img.shields.io/badge/Compliance-0.00%25%20Abandonment-success.svg)]()
[![License](https://img.shields.io/badge/License-MIT-purple.svg)]()

A production-grade **SmartDialer** prototype designed specifically for high-compliance outbound collections environments. 

SmartDialer resolves the fundamental trade-off in outbound contact centers: **maximizing agent utilization (75–95%) while mathematically guaranteeing zero abandoned calls (0.00% abandonment) to prevent statutory regulatory compliance violations.**

---

## 🏗️ Architectural Topology

SmartDialer implements a strict unidirectional pipeline where **the Pacing Engine has NO direct access to telecom providers**. Every dial proposal must pass through an independent, unbreakable **Safety Controller Firewall**:

```
┌─────────────────┐       ┌─────────────────┐       ┌────────────────────────┐       ┌──────────────────┐       ┌─────────────────────┐
│ Campaign Lead   │ ────► │  Pacing Engine  │ ────► │ ★ SAFETY CONTROLLER ★  │ ────► │  Call Allocator  │ ────► │   Telecom Carrier   │
│ & Agent Pool    │       │ (Prog / Pred)   │       │  (Unbreakable Firewall)│       │ (CAS Concurrency)│       │ (Prov A / Prov B)   │
└─────────────────┘       └─────────────────┘       └────────────────────────┘       └──────────────────┘       └─────────────────────┘
                                 │                              │
                                 ▼                              ▼
                         DialProposal                   SafetyVerdict
                         { requestedDials,              { APPROVE | REDUCE |
                           mathTrace }                    REJECT | FALLBACK }
```

---

## ⚡ Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Full Unit Test Suite (55 tests across 6 suites)
```bash
npm test
```

### 3. Run Concurrency & Stress Load Benchmarks
```bash
npm run loadtest
```

### 4. Run Multi-Scenario Simulation (Scenarios A, B, C, D)
```bash
npm run simulate
```

### 5. Launch Interactive Real-Time Web Dashboard
```bash
npm run dashboard
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser to view the real-time agent matrix, live gauges, and interactive chaos buttons.

---

## 🌟 Key Highlights & Engineering Features

### 1. Dual-Mode Pacing Engine
- **Deterministic Progressive Mode (1:1)**: Pairs each available agent with exactly one outbound dial. Perfect for low agent pools or volatile environments.
- **Statistical Predictive Mode**: Uses **Little's Law**, real-time **Bayesian Exponential Moving Averages (EMA)** for answer rates, and **Exponential Survival Functions** ($P(\text{free}) = 1 - e^{-t/\mu}$) on busy agents to accurately forecast capacity during the ring window.

### 2. The Safety Controller (Unbreakable Firewall)
- **Gate 1: Zero-Abandonment Headroom Check**: Trims over-dialing to safe capacity:
  $$D_{\text{approved}} \le \max(0, A_{\text{avail}} + \lfloor 0.4 \cdot \hat{A}_{\text{free}} \rfloor - C_{\text{ringing}})$$
- **Gate 2: Agent Availability Shock Protection**: Detects $>25\%$ agent logout within 5 seconds and instantly triggers **`FORCE_PROGRESSIVE_FALLBACK`**.
- **Gate 3: Circuit Breaker & Provider Health**: Trips `OPEN` on error rate $>15\%$ or P95 latency $>5\text{s}$, blocking outbound calls until recovery.
- **Gate 4: Minimum Sample Threshold**: Reverts to Progressive mode when fewer than 3 agents are active.
- **Gate 5: In-Flight Buffer Cap**: Caps maximum outstanding telecom calls at 200.

### 3. Concurrency Safety & Optimistic Locking (OCC / CAS)
- **Zero Double-Allocation**: Agents carry monotonic `version` integers. State transitions execute atomic Compare-And-Swap (CAS).
- If two workers attempt to reserve the same agent simultaneously, Worker 1 succeeds ($v \rightarrow v+1$) and Worker 2 receives a non-blocking `ConcurrencyConflictError` and grabs the next lead.

### 4. Resilient Call State Machine (Idempotency & Out-of-Order Webhooks)
- **Deduplication**: Every provider event ID is cached; duplicate webhooks (e.g. `ANSWERED → ANSWERED`) result in safe, idempotent no-ops.
- **DAG Skip-Ahead**: Out-of-order events (e.g. `COMPLETED → ANSWERED → RINGING`) advance the call directly to its terminal state and lock it against post-terminal corruption.

### 5. Watchdog Engine (Worker Crash Recovery)
- Periodically sweeps expired reservation leases (TTL 30s) if a worker crashes mid-dial.
- Reconciles orphaned calls and reconnects answered calls whose workers died during setup.

### 6. Mock Telecom Providers
- **Provider A (Reliable)**: 50–150ms latency, 99.8% reliability, strict in-order delivery.
- **Provider B (Chaos)**: 200–2000ms latency, 20% latency spikes, 15% duplicate events, 10% out-of-order webhooks, 8% failures.

---

## 📊 Empirical Simulation Results

Verified results from running `npm run simulate` across the 4 assignment test conditions:

| Scenario | Answer Rate | Talk Time | Mode | Calls Initiated | Answered | Abandonment % | Agent Utilization | Safety Interventions |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Scenario A** | 22.1% | 120s | Predictive | 149 | 33 | **0.00%** | **79.5%** | 42 |
| **Scenario B** | 50.0% | 90s | Predictive | 114 | 57 | **0.00%** | **85.6%** | 35 |
| **Scenario C** | 62.5% | 180s | Predictive | 64 | 40 | **0.00%** | **94.4%** | 43 |
| **Scenario D** | 36.1% | Dynamic | Predictive | 61 | 22 | **0.00%** | **44.9%** | 58 |

> ✅ **Zero Abandoned Calls (0.00%) maintained across all scenarios, including chaotic agent drops and provider failures.**

---

## 🖥️ Interactive Web Dashboard

Launch with `npm run dashboard` and navigate to `http://localhost:3000`:

- **Real-Time Agent Matrix**: Live visual indicators for all agents (`AVAILABLE`, `RESERVED`, `DIALING`, `CONNECTED`, `WRAP_UP`, `PAUSED`, `OFFLINE`).
- **Telemetry Gauges**: Real-time Answer Rate, Utilization %, In-flight Calls, and Abandonment Rate.
- **Interactive Chaos Injection**:
  - `+ Add 5 Agents`: Expand the active agent pool dynamically.
  - `⚡ Drop 10 Agents`: Trigger sudden agent logout to watch Agent Shock Protection fire live.
  - `💥 Trip Circuit`: Manually trip Provider Circuit Breaker to test dial suppression.
  - `1:1 Progressive` / `📊 Predictive`: Toggle pacing algorithm in real time.
- **Live SSE Event Stream**: Real-time log of state transitions, dial proposals, and Safety Controller verdicts.

---

## 📁 Repository Structure

```
Smart_Dialer/
├── src/
│   ├── types/
│   │   ├── agent.ts                # Agent states, transition matrix, OCC types
│   │   ├── call.ts                 # Call states, events, proposals, verdicts
│   │   └── provider.ts             # ITelecomProvider interface
│   ├── state-machine/
│   │   ├── agent-state-machine.ts  # Agent FSM + atomic CAS versioning
│   │   └── call-state-machine.ts   # Call FSM + idempotency dedup + DAG skip-ahead
│   ├── pacing/
│   │   ├── progressive-engine.ts   # Deterministic 1:1 progressive dialer
│   │   ├── predictive-engine.ts    # Statistical predictive engine (Little's Law)
│   │   └── stats-collector.ts      # Real-time Bayesian EMA stats collector
│   ├── safety/
│   │   ├── safety-controller.ts    # Zero-abandonment firewall (5 gates)
│   │   └── circuit-breaker.ts      # Provider health circuit breaker
│   ├── providers/
│   │   ├── mock-provider-a.ts      # Fast, reliable provider
│   │   └── mock-provider-b.ts      # Chaos provider (duplicates, out-of-order)
│   ├── allocator/
│   │   ├── call-allocator.ts       # Orchestrates dial lifecycle & worker binding
│   │   ├── borrower-queue.ts       # Priority lead queue with CAS claims
│   │   └── watchdog.ts             # Crash recovery & reservation lease sweeper
│   ├── simulation/
│   │   ├── dialer-simulator.ts     # Multi-scenario simulation runner (A–D)
│   │   └── load-tester.ts          # Concurrency & throughput stress benchmarks
│   ├── server/
│   │   └── app.ts                  # Express + Server-Sent Events (SSE) backend
│   └── index.ts                    # Main entry point
├── web/
│   └── index.html                  # Glassmorphism interactive real-time dashboard
├── tests/
│   ├── agent-state-machine.test.ts # 11 tests (CAS concurrency, transitions)
│   ├── call-state-machine.test.ts  # 10 tests (Idempotency, out-of-order)
│   ├── predictive-engine.test.ts   # 9 tests (Pacing math & reasoning trace)
│   ├── safety-controller.test.ts   # 12 tests (Headroom, shock drop, circuit breaker)
│   ├── worker-crash.test.ts        # 5 tests (Watchdog sweep & lease recovery)
│   └── dashboard-endpoints.test.ts # 8 tests (REST API & SSE integration)
├── docs/
│   ├── ARCHITECTURE.md             # Detailed system architecture document
│   ├── DECISIONS.md                # Direct answers to all assignment questions
│   └── SCALE_ANALYSIS.md           # 100 → 1K → 10K → 100K scaling roadmap
├── PROJECT_MASTER_GUIDE.md         # Comprehensive end-to-end master manual
└── README.md
```

---

## 📡 REST API & SSE Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/state` | Full system snapshot (agents, calls, safety, circuit breaker, allocator) |
| `GET` | `/api/agents` | All agent records with current versions and metrics |
| `GET` | `/api/events` | Server-Sent Events (SSE) live event stream |
| `POST`| `/api/allocator/start` | Start automated background dial loop |
| `POST`| `/api/allocator/stop` | Halt automated dial loop |
| `POST`| `/api/allocator/cycle` | Execute single manual dial cycle |
| `POST`| `/api/pacing` | Toggle pacing mode (`PROGRESSIVE` / `PREDICTIVE`) |
| `POST`| `/api/agents/add` | Inject new agents into the active pool |
| `POST`| `/api/agents/drop` | Trigger sudden agent logout (simulates agent shock) |
| `POST`| `/api/chaos/circuit-trip` | Trip provider circuit breaker to `OPEN` |

---

## 📚 Complete Documentation Index

- **[PROJECT_MASTER_GUIDE.md](file:///c:/Users/akram/OneDrive/Desktop/Smart_Dialer/PROJECT_MASTER_GUIDE.md)**: Exhaustive master guide covering mathematical derivations, state transitions, failover logic, and interview defense.
- **[docs/ARCHITECTURE.md](file:///c:/Users/akram/OneDrive/Desktop/Smart_Dialer/docs/ARCHITECTURE.md)**: Full architecture breakdown, subsystem topologies, and sequence diagrams.
- **[docs/DECISIONS.md](file:///c:/Users/akram/OneDrive/Desktop/Smart_Dialer/docs/DECISIONS.md)**: In-depth technical answers to all 8 assignment interview questions.
- **[docs/SCALE_ANALYSIS.md](file:///c:/Users/akram/OneDrive/Desktop/Smart_Dialer/docs/SCALE_ANALYSIS.md)**: Deep dive into bottlenecks and distributed system designs across 100, 1K, 10K, and 100K agent tiers.
