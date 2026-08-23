// ─── Dashboard API Endpoints Integration Test ─────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../src/server/app.js';
import http from 'http';

describe('Dashboard API Endpoints', () => {
  let server: http.Server;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    // Start on ephemeral port for testing
    server = app.listen(0);
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      port = addr.port;
      baseUrl = `http://localhost:${port}`;
    }
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('GET /api/state should return complete system state', async () => {
    const res = await fetch(`${baseUrl}/api/state`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.agents).toBeDefined();
    expect(data.calls).toBeDefined();
    expect(data.safety).toBeDefined();
    expect(data.circuitBreaker).toBeDefined();
    expect(data.allocator).toBeDefined();
    expect(data.providerHealth).toBeDefined();
  });

  it('GET /api/agents should return list of all agents', async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it('POST /api/agents/add should increase agent count', async () => {
    const res = await fetch(`${baseUrl}/api/agents/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 5 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.added).toBe(5);
    expect(data.total).toBeGreaterThanOrEqual(35);
  });

  it('POST /api/agents/drop should drop agents without error', async () => {
    const res = await fetch(`${baseUrl}/api/agents/drop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 10 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dropped).toBeGreaterThan(0);
    expect(data.totalOnline).toBeDefined();
  });

  it('POST /api/allocator/start and /stop should control dialer lifecycle', async () => {
    const startRes = await fetch(`${baseUrl}/api/allocator/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalMs: 2000, pacingMode: 'PROGRESSIVE' }),
    });
    expect(startRes.status).toBe(200);
    const startData = await startRes.json();
    expect(startData.status).toBe('started');

    const stopRes = await fetch(`${baseUrl}/api/allocator/stop`, { method: 'POST' });
    expect(stopRes.status).toBe(200);
    const stopData = await stopRes.json();
    expect(stopData.status).toBe('stopped');
  });

  it('POST /api/allocator/cycle should execute a manual dial cycle', async () => {
    const res = await fetch(`${baseUrl}/api/allocator/cycle`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.proposal).toBeDefined();
    expect(data.verdict).toBeDefined();
  });

  it('POST /api/pacing should toggle pacing mode', async () => {
    const res1 = await fetch(`${baseUrl}/api/pacing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'PREDICTIVE' }),
    });
    expect(res1.status).toBe(200);
    const d1 = await res1.json();
    expect(d1.pacingMode).toBe('PREDICTIVE');

    const res2 = await fetch(`${baseUrl}/api/pacing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'PROGRESSIVE' }),
    });
    expect(res2.status).toBe(200);
    const d2 = await res2.json();
    expect(d2.pacingMode).toBe('PROGRESSIVE');
  });

  it('POST /api/chaos/circuit-trip should trip circuit breaker', async () => {
    const res = await fetch(`${baseUrl}/api/chaos/circuit-trip`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.circuitState).toBe('OPEN');
  });
});
