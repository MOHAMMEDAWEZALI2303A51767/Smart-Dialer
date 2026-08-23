# Scale Analysis: 100 → 1K → 10K → 100K Agents

## Overview

This document analyzes how each SmartDialer component needs to evolve as we scale from 100 agents to 100,000 agents. For each scale tier, we identify the primary bottlenecks and propose solutions.

---

## Tier 1: 100 Agents

**Architecture**: Single-process monolith

| Component | Implementation | Bottleneck | Notes |
|-----------|---------------|------------|-------|
| Agent SM | In-memory Map | None | 100 entries trivial |
| Call SM | In-memory Map | None | ~500 concurrent calls |
| Pacing Engine | In-process loop | None | Math computed in <1ms |
| Safety Controller | In-process | None | Single evaluation per cycle |
| Provider | Single connection | None | ~50 concurrent calls |
| Stats Collector | In-memory EMA | None | O(1) updates |
| Watchdog | In-process timer | None | Sweeps 100 agents in <1ms |
| Dashboard | Single Express server | None | 1-5 SSE clients |

**Deployment**: Single Node.js process. No infrastructure beyond the application server.

---

## Tier 2: 1,000 Agents

**Architecture**: Single process, optimized data structures

| Component | Change Required | Bottleneck | Solution |
|-----------|----------------|------------|----------|
| Agent SM | Indexed Map | CAS contention | Shard by agent ID hash (4 shards) |
| Call SM | Indexed Map | Memory growth | Evict completed calls after 5min TTL |
| Pacing Engine | None | Agent pool scan | Pre-computed availability counters |
| Safety Controller | None | None | Same logic, just more proposals |
| Provider | Connection pool | TCP connections | Pool of 50 connections, round-robin |
| Stats Collector | None | None | Same EMA, more samples |
| Watchdog | None | Sweep time | Indexed query by reservationExpiry |
| Dashboard | SSE fan-out | Broadcast overhead | Message batching (100ms window) |

**Key Change**: Provider connection pooling and call record eviction to manage memory.

**Deployment**: Single process, possibly 2 for HA. Redis for cross-instance agent state if HA needed.

---

## Tier 3: 10,000 Agents

**Architecture**: Microservices with shared state store

| Component | Change Required | Bottleneck | Solution |
|-----------|----------------|------------|----------|
| Agent SM | Redis / DynamoDB | Network latency for CAS | Lua script atomic CAS in Redis; partition by agent group |
| Call SM | Partitioned database | Write throughput | Partition calls by callId hash across N shards |
| Pacing Engine | Dedicated service | Stale reads | Pacing service reads from Redis, publishes proposals to message queue |
| Safety Controller | Dedicated service | Cross-partition reads | Aggregate stats service provides near-real-time agent/call counts |
| Provider | Multi-region pool | SLA compliance | Geo-distributed provider connections; regional call routing |
| Stats Collector | Streaming aggregation | Real-time accuracy | Apache Kafka / Redis Streams for event-driven stats |
| Watchdog | Distributed sweeper | Coordination | Leader election (Redis SETNX) + partition-aware sweeps |
| Dashboard | WebSocket cluster | 100+ concurrent viewers | Load-balanced WebSocket servers with pub/sub backend |

**New Components Needed**:
- **Message Queue** (Kafka/SQS): Decouple pacing proposals from call execution
- **Distributed Lock Service** (Redis/ZooKeeper): Coordinate watchdog leaders
- **Metrics Pipeline** (Prometheus/Grafana): Observability at scale
- **Event Store**: Audit trail for compliance

**Deployment**: Kubernetes cluster with 10-20 service replicas, Redis cluster, PostgreSQL with read replicas.

---

## Tier 4: 100,000 Agents

**Architecture**: Globally distributed, event-sourced system

| Component | Change Required | Bottleneck | Solution |
|-----------|----------------|------------|----------|
| Agent SM | Distributed FSM cluster | Global consistency | CRDT-based state with eventual consistency; strong consistency only for reservation (via distributed lock) |
| Call SM | Event-sourced (Kafka + materialized views) | Write amplification | Append-only event log; partition by callId; materialized views for queries |
| Pacing Engine | Distributed with consensus | Global optimum | Hierarchical: regional pacers → global coordinator. Each region paces independently with capacity budget |
| Safety Controller | Distributed with quorum | Split-brain risk | Safety checks run at regional level AND global aggregator. Global veto on regional proposals if aggregate risk too high |
| Provider | Global mesh | Regulatory compliance | Region-aware routing; provider failover mesh; compliance boundary enforcement |
| Stats Collector | Real-time streaming | Volume | Flink/Spark Streaming with sliding window aggregations |
| Watchdog | Multi-region sweeper | Distributed failures | Regional watchdogs + global reconciliation. Saga pattern for cross-region recovery |
| Dashboard | CDN + WebSocket mesh | Global latency | Edge-deployed dashboards; regional aggregation; client-side optimistic rendering |

**Critical New Challenges at 100K**:

### 1. Consistency vs. Availability Trade-off
- **Agent Reservation**: Must be strongly consistent (CP) — use distributed lock (Redlock or consensus-based)
- **Call Statistics**: Can be eventually consistent (AP) — EMA naturally tolerates stale reads
- **Safety Controller**: Hybrid — local checks immediate, global aggregation eventual (within 1s SLA)

### 2. Partition Tolerance
- Regional partitions must continue operating independently with local safety guarantees
- Global coordinator provides cross-region optimization but is not required for safety
- Each region defaults to Progressive mode during partition

### 3. Provider Rate Limiting
- 100K agents × 3x over-dial = 300K concurrent calls
- Provider API rate limits require multi-provider federation
- Automatic provider failover and load balancing across 5-10 providers

### 4. Database Design
```
┌──────────────────────────────────────────────────────────┐
│  Event Log (Kafka)                                       │
│  • agent.state.changed                                   │
│  • call.state.changed                                    │
│  • safety.verdict.issued                                 │
│  • provider.event.received                               │
├──────────────────────────────────────────────────────────┤
│  Materialized Views                                      │
│  • agent_current_state (Redis, keyed by agentId)         │
│  • call_current_state (Cassandra, partitioned by callId) │
│  • realtime_stats (Druid/ClickHouse, time-series)        │
│  • audit_log (S3/GCS, immutable)                         │
└──────────────────────────────────────────────────────────┘
```

### 5. Deployment Architecture
```
                     ┌─────────────┐
                     │   Global    │
                     │ Coordinator │
                     └──────┬──────┘
                            │
           ┌────────────────┼────────────────┐
           │                │                │
    ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐
    │  Region US  │  │  Region EU  │  │  Region APAC│
    │  ~30K agents│  │  ~40K agents│  │  ~30K agents│
    │             │  │             │  │             │
    │  ┌────────┐ │  │  ┌────────┐ │  │  ┌────────┐ │
    │  │ Pacer  │ │  │  │ Pacer  │ │  │  │ Pacer  │ │
    │  │ Safety │ │  │  │ Safety │ │  │  │ Safety │ │
    │  │ Alloc. │ │  │  │ Alloc. │ │  │  │ Alloc. │ │
    │  └────────┘ │  │  └────────┘ │  │  └────────┘ │
    └─────────────┘  └─────────────┘  └─────────────┘
```

---

## Summary: Scaling Strategy

| Aspect | 100 | 1K | 10K | 100K |
|--------|-----|-----|------|-------|
| State Storage | In-memory | In-memory + Redis | Redis Cluster + DB | Event-sourced + CRDT |
| Concurrency | Single-thread CAS | Sharded CAS | Distributed lock | Regional CAS + global reconciliation |
| Pacing | In-process | In-process | Dedicated service | Hierarchical regional pacers |
| Safety | In-process | In-process | Dedicated service | Regional + global aggregator |
| Provider | Single | Connection pool | Multi-region | Global federation mesh |
| Deployment | Single process | 2-3 processes | K8s cluster (10-20 pods) | Multi-region K8s (100+ pods) |
| Latency SLA | <10ms | <50ms | <200ms | <500ms regional, <1s global |
| Annual Cost | $100/mo | $500/mo | $10K/mo | $100K+/mo |
