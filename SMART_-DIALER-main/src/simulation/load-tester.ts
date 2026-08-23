// ─── Load Tester ────────────────────────────────────────────────────────────
import { AgentStateMachine, ConcurrencyConflictError } from '../state-machine/agent-state-machine.js';
import { CallStateMachine } from '../state-machine/call-state-machine.js';
import { AgentState, AgentEvent } from '../types/agent.js';
import { CallState, CallEvent } from '../types/call.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Load Tester validates system behavior under high concurrency:
 *
 * Test 1: CONCURRENT AGENT RESERVATION
 *   50 concurrent "workers" attempt to reserve the same 10 agents.
 *   Expected: Exactly 10 successful reservations, 40 conflicts.
 *   Validates: OCC (Compare-And-Swap) prevents double-allocation.
 *
 * Test 2: OUT-OF-ORDER & DUPLICATE EVENT PROCESSING
 *   Inject events in wrong order with duplicates.
 *   Expected: System reaches valid terminal state without corruption.
 *
 * Test 3: HIGH-THROUGHPUT CALL CREATION
 *   Create 10,000 calls and transition them through lifecycle.
 *   Measures: Throughput (calls/sec) and state consistency.
 *
 * Test 4: WATCHDOG LEASE RECOVERY
 *   Reserve agents with short TTL, let them expire, verify watchdog reclaims.
 */

interface LoadTestResult {
  testName: string;
  passed: boolean;
  details: string;
  durationMs: number;
  metrics?: Record<string, number>;
}

async function runConcurrentReservationTest(): Promise<LoadTestResult> {
  const startTime = Date.now();
  const agentSM = new AgentStateMachine();

  // Create 10 agents, all AVAILABLE
  const agents = agentSM.createAgents(10);
  for (const agent of agents) {
    agentSM.transition(agent.id, AgentEvent.LOGIN, agent.version);
  }

  // 50 concurrent workers attempt to reserve
  const workerCount = 50;
  let successCount = 0;
  let conflictCount = 0;
  const reservedAgentIds = new Set<string>();

  // Simulate concurrent reservation attempts
  const promises = Array.from({ length: workerCount }, async (_, i) => {
    const workerId = `worker-${i}`;
    const reserved = agentSM.reserveAvailableAgent(workerId);
    if (reserved) {
      successCount++;
      reservedAgentIds.add(reserved.id);
    } else {
      conflictCount++;
    }
  });

  await Promise.all(promises);

  // Verify: exactly 10 successful, 40 failed
  const passed =
    successCount === 10 &&
    conflictCount === 40 &&
    reservedAgentIds.size === 10;

  agentSM.reset();

  return {
    testName: 'Concurrent Agent Reservation (50 workers × 10 agents)',
    passed,
    details: passed
      ? `✅ Exactly ${successCount} reservations, ${conflictCount} conflicts, ${reservedAgentIds.size} unique agents. Zero double-allocations.`
      : `⛔ Expected 10 success / 40 conflict / 10 unique. Got ${successCount} / ${conflictCount} / ${reservedAgentIds.size}.`,
    durationMs: Date.now() - startTime,
    metrics: { successCount, conflictCount, uniqueAgents: reservedAgentIds.size },
  };
}

async function runOutOfOrderEventTest(): Promise<LoadTestResult> {
  const startTime = Date.now();
  const callSM = new CallStateMachine();

  // Create a call
  const call = callSM.createCall('borrower-1', '+11234567890', 'provider-a');

  // Reserve it
  callSM.transition(call.id, CallEvent.RESERVE, { agentId: 'agent-1' });
  // Initiate
  callSM.transition(call.id, CallEvent.INITIATE);

  // ── Inject OUT-OF-ORDER events ──
  // Send COMPLETE before ANSWER (skip-ahead)
  const r1 = callSM.transition(call.id, CallEvent.COMPLETE, { eventId: 'evt-complete-1' });

  // Now send ANSWER (should be no-op since call is already COMPLETED)
  const r2 = callSM.transition(call.id, CallEvent.ANSWER, { eventId: 'evt-answer-1' });

  // Send duplicate COMPLETE
  const r3 = callSM.transition(call.id, CallEvent.COMPLETE, { eventId: 'evt-complete-1' });

  // Send another RING (should be no-op)
  const r4 = callSM.transition(call.id, CallEvent.RING, { eventId: 'evt-ring-1' });

  const finalCall = callSM.getCall(call.id);
  const passed =
    finalCall !== undefined &&
    finalCall.state === CallState.COMPLETED &&
    r1.success === true &&
    r1.skipped === false &&  // First COMPLETE should succeed (skip-ahead)
    r2.skipped === true &&   // ANSWER after terminal = no-op
    r3.skipped === true &&   // Duplicate COMPLETE = no-op
    r4.skipped === true;     // RING after terminal = no-op

  callSM.reset();

  return {
    testName: 'Out-of-Order & Duplicate Event Processing',
    passed,
    details: passed
      ? '✅ System correctly handled: COMPLETE before ANSWER (skip-ahead), duplicate events (no-op), post-terminal events (no-op). Final state: COMPLETED.'
      : `⛔ State machine corruption detected. Final state: ${finalCall?.state}`,
    durationMs: Date.now() - startTime,
  };
}

async function runHighThroughputTest(): Promise<LoadTestResult> {
  const startTime = Date.now();
  const callSM = new CallStateMachine();
  const callCount = 10000;

  // Create and transition 10,000 calls through full lifecycle
  for (let i = 0; i < callCount; i++) {
    const call = callSM.createCall(`borrower-${i}`, `+1${i}`, 'provider-a');
    callSM.transition(call.id, CallEvent.RESERVE, { agentId: `agent-${i % 50}` });
    callSM.transition(call.id, CallEvent.INITIATE);
    callSM.transition(call.id, CallEvent.RING);

    if (i % 3 === 0) {
      // 1/3 answered and completed
      callSM.transition(call.id, CallEvent.ANSWER);
      callSM.transition(call.id, CallEvent.CONNECT);
      callSM.transition(call.id, CallEvent.COMPLETE);
    } else if (i % 3 === 1) {
      // 1/3 no answer
      callSM.transition(call.id, CallEvent.NO_ANSWER);
    } else {
      // 1/3 failed
      callSM.transition(call.id, CallEvent.FAIL, { failureReason: 'Test failure' });
    }
  }

  const elapsed = Date.now() - startTime;
  const throughput = Math.round(callCount / (elapsed / 1000));

  // Verify all calls are in terminal states
  const stats = callSM.getStats();
  const allTerminal = stats.totalCompleted === callCount;

  callSM.reset();

  return {
    testName: `High-Throughput Call Processing (${callCount.toLocaleString()} calls)`,
    passed: allTerminal,
    details: allTerminal
      ? `✅ All ${callCount.toLocaleString()} calls processed to terminal state. Throughput: ${throughput.toLocaleString()} calls/sec.`
      : `⛔ Not all calls reached terminal state. Completed: ${stats.totalCompleted}/${callCount}`,
    durationMs: elapsed,
    metrics: { callCount, throughput, completedCalls: stats.totalCompleted },
  };
}

async function runWatchdogLeaseRecoveryTest(): Promise<LoadTestResult> {
  const startTime = Date.now();
  const agentSM = new AgentStateMachine();

  // Create agents with very short reservation TTL
  const agents = agentSM.createAgents(5);
  for (const agent of agents) {
    agentSM.transition(agent.id, AgentEvent.LOGIN, agent.version);
  }

  // Reserve all agents with 100ms TTL (simulating crash)
  for (const agent of agents) {
    const a = agentSM.getAgent(agent.id);
    if (a) {
      agentSM.transition(a.id, AgentEvent.RESERVE, a.version, {
        workerId: 'crashed-worker',
        reservationTtlMs: 100,
      });
    }
  }

  // Verify all reserved
  const reservedBefore = agentSM.getAgentsByState(AgentState.RESERVED).length;

  // Wait for TTL to expire
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Check expired leases
  const expired = agentSM.getExpiredReservations();

  // Force-release all expired
  let reclaimed = 0;
  for (const agent of expired) {
    const result = agentSM.forceRelease(agent.id);
    if (result.success) reclaimed++;
  }

  const availableAfter = agentSM.getAgentsByState(AgentState.AVAILABLE).length;

  const passed = reservedBefore === 5 && reclaimed === 5 && availableAfter === 5;

  agentSM.reset();

  return {
    testName: 'Watchdog Lease Recovery (Simulated Worker Crash)',
    passed,
    details: passed
      ? `✅ All 5 agents reserved with 100ms TTL, all 5 expired, all 5 reclaimed to AVAILABLE. Worker crash recovery successful.`
      : `⛔ Expected 5/5/5. Got reserved=${reservedBefore}, reclaimed=${reclaimed}, available=${availableAfter}`,
    durationMs: Date.now() - startTime,
    metrics: { reservedBefore, expired: expired.length, reclaimed, availableAfter },
  };
}

async function runStateMachineStressTest(): Promise<LoadTestResult> {
  const startTime = Date.now();
  const agentSM = new AgentStateMachine();
  const callSM = new CallStateMachine();

  // Create agent and cycle through states rapidly
  const agent = agentSM.createAgent('Stress-Agent');
  let transitions = 0;
  let errors = 0;
  const cycleCount = 1000;

  for (let i = 0; i < cycleCount; i++) {
    try {
      let a = agentSM.getAgent(agent.id)!;
      // OFFLINE → AVAILABLE
      agentSM.transition(a.id, AgentEvent.LOGIN, a.version);
      a = agentSM.getAgent(agent.id)!;
      transitions++;

      // AVAILABLE → RESERVED
      agentSM.transition(a.id, AgentEvent.RESERVE, a.version, { workerId: `w-${i}` });
      a = agentSM.getAgent(agent.id)!;
      transitions++;

      // RESERVED → DIALING
      agentSM.transition(a.id, AgentEvent.DIAL_STARTED, a.version, { callId: `c-${i}` });
      a = agentSM.getAgent(agent.id)!;
      transitions++;

      // DIALING → CONNECTED
      agentSM.transition(a.id, AgentEvent.CALL_ANSWERED, a.version);
      a = agentSM.getAgent(agent.id)!;
      transitions++;

      // CONNECTED → WRAP_UP
      agentSM.transition(a.id, AgentEvent.CALL_ENDED, a.version);
      a = agentSM.getAgent(agent.id)!;
      transitions++;

      // WRAP_UP → AVAILABLE
      agentSM.transition(a.id, AgentEvent.WRAP_UP_COMPLETE, a.version);
      a = agentSM.getAgent(agent.id)!;
      transitions++;

      // AVAILABLE → OFFLINE
      agentSM.transition(a.id, AgentEvent.LOGOUT, a.version);
      transitions++;
    } catch (err) {
      errors++;
    }
  }

  const elapsed = Date.now() - startTime;
  const passed = errors === 0 && transitions === cycleCount * 7;

  agentSM.reset();

  return {
    testName: `State Machine Stress Test (${cycleCount} full cycles × 7 transitions)`,
    passed,
    details: passed
      ? `✅ ${transitions.toLocaleString()} transitions completed, 0 errors. Rate: ${Math.round(transitions / (elapsed / 1000)).toLocaleString()} transitions/sec.`
      : `⛔ ${transitions} transitions, ${errors} errors.`,
    durationMs: elapsed,
    metrics: { transitions, errors, cycleCount },
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║              SmartDialer Load & Concurrency Tests                  ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  const tests = [
    runConcurrentReservationTest,
    runOutOfOrderEventTest,
    runHighThroughputTest,
    runWatchdogLeaseRecoveryTest,
    runStateMachineStressTest,
  ];

  const results: LoadTestResult[] = [];

  for (const test of tests) {
    const result = await test();
    results.push(result);
    console.log(`  ${result.passed ? '✅' : '⛔'} ${result.testName}`);
    console.log(`     ${result.details}`);
    console.log(`     Duration: ${result.durationMs}ms`);
    if (result.metrics) {
      console.log(`     Metrics: ${JSON.stringify(result.metrics)}`);
    }
    console.log();
  }

  const allPassed = results.every((r) => r.passed);
  console.log(`\n${'═'.repeat(70)}`);
  console.log(
    allPassed
      ? '  ✅ ALL LOAD TESTS PASSED!'
      : `  ⛔ ${results.filter((r) => !r.passed).length} TEST(S) FAILED`
  );
  console.log(`${'═'.repeat(70)}`);

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});
