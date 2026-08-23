# SmartDialer Architecture

## System Overview

SmartDialer is a production-grade predictive dialer prototype designed for the collections domain.
It solves the core challenge: **maximizing agent utilization while guaranteeing zero compliance violations from abandoned calls**.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Campaign Manager                            │
│   • Lead Queue (Borrower prioritization by urgency/timezone)        │
│   • Agent Pool (Skill-based routing, availability tracking)         │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Pacing Engine                                │
│                                                                     │
│   ┌──────────────────┐      ┌──────────────────────────────────┐   │
│   │ Progressive Mode  │      │ Predictive Mode                  │   │
│   │ • 1:1 agent:call  │      │ • Statistical over-dialing       │   │
│   │ • Zero risk       │      │ • Erlang-C / Survival Function   │   │
│   │ • Lower util.     │      │ • EMA Answer Rate Tracking       │   │
│   └──────────────────┘      │ • Little's Law Application       │   │
│                              └──────────────────────────────────┘   │
│                                                                     │
│   Output: DialProposal { requestedDials, mathTrace, reason }        │
└────────────────────────────┬────────────────────────────────────────┘
                             │ Proposal
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│              ★ SAFETY CONTROLLER (Firewall) ★                      │
│                                                                     │
│   1. Zero-Abandonment Headroom Check                                │
│      D_approved ≤ floor(A_avail / p_worst_case) - C_ringing        │
│                                                                     │
│   2. Agent Shock Detection (>25% drop in 5s → fallback)             │
│                                                                     │
│   3. Provider Health / Circuit Breaker                              │
│      CLOSED → OPEN (error>15% or P95>5s) → HALF_OPEN → CLOSED     │
│                                                                     │
│   4. In-Flight Call Limit                                           │
│                                                                     │
│   5. Minimum Agent Threshold for Predictive                         │
│                                                                     │
│   Output: SafetyVerdict { APPROVE | REDUCE | REJECT | FALLBACK }    │
└────────────────────────────┬────────────────────────────────────────┘
                             │ Approved Permits
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   Call Allocator & Concurrency Engine                │
│                                                                     │
│   • Atomic Agent Reservation (CAS/OCC versioned state)              │
│   • Call → Agent Pre-Mapping                                        │
│   • Provider Event Processing (dedup + out-of-order)                │
│   • Answered Call → Agent Connection                                │
│   • Wrap-Up → Release cycle                                        │
│                                                                     │
│   ┌───────────────────────────────────────────────────────────┐     │
│   │ Watchdog                                                   │     │
│   │ • Sweeps expired agent reservations (crash recovery)       │     │
│   │ • Recovers orphaned calls stuck in non-terminal states     │     │
│   │ • Detects agent-call state mismatches                      │     │
│   └───────────────────────────────────────────────────────────┘     │
└────────────────────────────┬────────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                              ▼
┌───────────────────────┐    ┌───────────────────────────┐
│  Provider A (Reliable) │    │  Provider B (Chaos)        │
│  • 50-150ms latency    │    │  • 200-2000ms + spikes     │
│  • 99.8% success       │    │  • 15% duplicate events    │
│  • In-order events     │    │  • 10% out-of-order events │
│  • No duplicates       │    │  • 8% failure rate         │
└───────────────────────┘    └───────────────────────────┘
```

## Agent State Machine

```
         LOGIN                    RESERVE                DIAL_STARTED
OFFLINE ──────→ AVAILABLE ──────→ RESERVED ──────→ DIALING
    ↑               ↕                ↓                  ↓
    │            PAUSE/RESUME    RELEASE/LOGOUT    CALL_ANSWERED
    │               ↕                ↓                  ↓
    │           PAUSED           (AVAILABLE)        CONNECTED
    │                                                   ↓
    │                                              CALL_ENDED
    │                                                   ↓
    │                                               WRAP_UP
    │                                                   ↓
    └────────── LOGOUT ←──── WRAP_UP_COMPLETE ←── AVAILABLE
```

### Concurrency Protection (OCC)

Every agent carries a `version` integer. State transitions use Compare-And-Swap:

```typescript
// Worker A reads agent: { state: AVAILABLE, version: 5 }
// Worker B reads agent: { state: AVAILABLE, version: 5 }

// Worker A: CAS(AVAILABLE→RESERVED, version=5→6) → ✅ SUCCESS
// Worker B: CAS(AVAILABLE→RESERVED, version=5→6) → ❌ CONFLICT (version is now 6)
```

## Call State Machine

```
         RESERVE       INITIATE       RING         ANSWER        CONNECT       COMPLETE
QUEUED ──────→ RESERVED ──────→ INITIATED ──────→ RINGING ──────→ ANSWERED ──────→ CONNECTED ──────→ COMPLETED
                  ↓          ↓           ↓           ↓              ↓              ↓
               CANCEL      FAIL        FAIL        FAIL           FAIL           FAIL
                             ↓           ↓           ↓              ↓
                          FAILED      CANCELLED   NO_ANSWER     COMPLETED
```

### Out-of-Order & Idempotency

- **Deduplication**: Every event has a unique `eventId`. Processed IDs are cached. Duplicates → safe no-op.
- **Skip-ahead**: Terminal states (COMPLETED, FAILED, CANCELLED) are reachable from ANY non-terminal state.
- **Post-terminal**: Events arriving after terminal state → safe no-op with logged reason.

## Predictive Pacing Mathematical Model

```
D_t = max(0, min(D_max_safe, floor((A_avail + Â_free(t_ring)) / p_ans - C_ringing)))
```

Where:
- `A_avail` = Currently idle agents
- `Â_free(t_ring)` = Predicted agents becoming free within ring window
  - Uses exponential survival function: `P(remaining ≤ t) = 1 - exp(-t/μ)`
- `p_ans` = EMA-smoothed answer rate: `p_t = β·p_(t-1) + (1-β)·sample`
- `C_ringing` = Currently outstanding in-flight calls

## Technology Stack

- **Runtime**: Node.js 22 + TypeScript 5.5
- **Testing**: Vitest
- **Server**: Express.js with SSE
- **Dashboard**: Vanilla HTML/CSS/JS with glassmorphism design
