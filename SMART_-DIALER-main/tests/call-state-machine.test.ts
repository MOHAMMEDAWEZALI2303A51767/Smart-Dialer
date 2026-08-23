import { describe, it, expect, beforeEach } from 'vitest';
import { CallStateMachine } from '../src/state-machine/call-state-machine';
import { CallState, CallEvent, CallDisposition } from '../src/types/call';

describe('CallStateMachine', () => {
  let sm: CallStateMachine;

  beforeEach(() => {
    sm = new CallStateMachine();
  });

  describe('Call Creation', () => {
    it('should create a call in QUEUED state', () => {
      const call = sm.createCall('b1', '+11234567890', 'prov-a');
      expect(call.state).toBe(CallState.QUEUED);
      expect(call.borrowerId).toBe('b1');
      expect(call.agentId).toBeNull();
    });
  });

  describe('Normal Lifecycle', () => {
    it('should transition through full lifecycle', () => {
      const call = sm.createCall('b1', '+11234567890', 'prov-a');

      sm.transition(call.id, CallEvent.RESERVE, { agentId: 'a1' });
      sm.transition(call.id, CallEvent.INITIATE);
      sm.transition(call.id, CallEvent.RING);
      sm.transition(call.id, CallEvent.ANSWER);
      sm.transition(call.id, CallEvent.CONNECT, { agentId: 'a1' });
      sm.transition(call.id, CallEvent.COMPLETE);

      const final = sm.getCall(call.id)!;
      expect(final.state).toBe(CallState.COMPLETED);
      expect(final.disposition).toBe(CallDisposition.ANSWERED);
      expect(final.agentId).toBe('a1');
    });

    it('should handle NO_ANSWER', () => {
      const call = sm.createCall('b1', '+1', 'prov-a');
      sm.transition(call.id, CallEvent.RESERVE);
      sm.transition(call.id, CallEvent.INITIATE);
      sm.transition(call.id, CallEvent.RING);
      sm.transition(call.id, CallEvent.NO_ANSWER);

      const final = sm.getCall(call.id)!;
      expect(final.state).toBe(CallState.COMPLETED);
      expect(final.disposition).toBe(CallDisposition.NO_ANSWER);
    });

    it('should handle FAIL from any non-terminal state', () => {
      const call = sm.createCall('b1', '+1', 'prov-a');
      sm.transition(call.id, CallEvent.RESERVE);
      sm.transition(call.id, CallEvent.INITIATE);
      sm.transition(call.id, CallEvent.FAIL, { failureReason: 'Provider error' });

      const final = sm.getCall(call.id)!;
      expect(final.state).toBe(CallState.FAILED);
      expect(final.failureReason).toBe('Provider error');
    });
  });

  describe('Idempotent Deduplication', () => {
    it('should deduplicate events with the same eventId', () => {
      const call = sm.createCall('b1', '+1', 'prov-a');
      sm.transition(call.id, CallEvent.RESERVE);
      sm.transition(call.id, CallEvent.INITIATE);
      sm.transition(call.id, CallEvent.RING);

      // First ANSWER event
      const r1 = sm.transition(call.id, CallEvent.ANSWER, { eventId: 'evt-1' });
      expect(r1.success).toBe(true);
      expect(r1.skipped).toBe(false);

      // Duplicate ANSWER with same eventId
      const r2 = sm.transition(call.id, CallEvent.ANSWER, { eventId: 'evt-1' });
      expect(r2.success).toBe(true);
      expect(r2.skipped).toBe(true);
      expect(r2.reason).toContain('Duplicate');

      // Triple duplicate
      const r3 = sm.transition(call.id, CallEvent.ANSWER, { eventId: 'evt-1' });
      expect(r3.skipped).toBe(true);
    });
  });

  describe('Out-of-Order Event Handling', () => {
    it('should handle COMPLETE arriving before ANSWER (skip-ahead)', () => {
      const call = sm.createCall('b1', '+1', 'prov-a');
      sm.transition(call.id, CallEvent.RESERVE);
      sm.transition(call.id, CallEvent.INITIATE);

      // COMPLETE arrives directly (skipping RING and ANSWER)
      const result = sm.transition(call.id, CallEvent.COMPLETE, { eventId: 'evt-complete' });
      expect(result.success).toBe(true);
      expect(result.skipped).toBe(false);

      const final = sm.getCall(call.id)!;
      expect(final.state).toBe(CallState.COMPLETED);
    });

    it('should ignore events after terminal state', () => {
      const call = sm.createCall('b1', '+1', 'prov-a');
      sm.transition(call.id, CallEvent.RESERVE);
      sm.transition(call.id, CallEvent.INITIATE);
      sm.transition(call.id, CallEvent.COMPLETE);

      // Try ANSWER after COMPLETED — should be no-op
      const r1 = sm.transition(call.id, CallEvent.ANSWER, { eventId: 'late-answer' });
      expect(r1.skipped).toBe(true);
      expect(r1.reason).toContain('terminal state');

      // Try RING after COMPLETED — should be no-op
      const r2 = sm.transition(call.id, CallEvent.RING, { eventId: 'late-ring' });
      expect(r2.skipped).toBe(true);

      // State should still be COMPLETED
      expect(sm.getCall(call.id)!.state).toBe(CallState.COMPLETED);
    });

    it('should handle COMPLETED → ANSWERED → ANSWERED → RINGING sequence', () => {
      const call = sm.createCall('b1', '+1', 'prov-a');
      sm.transition(call.id, CallEvent.RESERVE);
      sm.transition(call.id, CallEvent.INITIATE);

      // Fully out-of-order: COMPLETE first
      sm.transition(call.id, CallEvent.COMPLETE, { eventId: 'e1' });
      // Then ANSWER
      const r2 = sm.transition(call.id, CallEvent.ANSWER, { eventId: 'e2' });
      expect(r2.skipped).toBe(true);
      // Then duplicate ANSWER
      const r3 = sm.transition(call.id, CallEvent.ANSWER, { eventId: 'e3' });
      expect(r3.skipped).toBe(true);
      // Then RING
      const r4 = sm.transition(call.id, CallEvent.RING, { eventId: 'e4' });
      expect(r4.skipped).toBe(true);

      // Final state must be COMPLETED
      expect(sm.getCall(call.id)!.state).toBe(CallState.COMPLETED);
    });
  });

  describe('Statistics', () => {
    it('should compute correct call statistics', () => {
      // Create 10 calls: 3 answered, 4 no-answer, 3 failed
      for (let i = 0; i < 3; i++) {
        const c = sm.createCall(`b-${i}`, `+1${i}`, 'p');
        sm.transition(c.id, CallEvent.RESERVE);
        sm.transition(c.id, CallEvent.INITIATE);
        sm.transition(c.id, CallEvent.RING);
        sm.transition(c.id, CallEvent.ANSWER);
        sm.transition(c.id, CallEvent.CONNECT);
        sm.transition(c.id, CallEvent.COMPLETE);
      }

      for (let i = 3; i < 7; i++) {
        const c = sm.createCall(`b-${i}`, `+1${i}`, 'p');
        sm.transition(c.id, CallEvent.RESERVE);
        sm.transition(c.id, CallEvent.INITIATE);
        sm.transition(c.id, CallEvent.RING);
        sm.transition(c.id, CallEvent.NO_ANSWER);
      }

      for (let i = 7; i < 10; i++) {
        const c = sm.createCall(`b-${i}`, `+1${i}`, 'p');
        sm.transition(c.id, CallEvent.RESERVE);
        sm.transition(c.id, CallEvent.INITIATE);
        sm.transition(c.id, CallEvent.FAIL, { failureReason: 'test' });
      }

      const stats = sm.getStats();
      expect(stats.totalInitiated).toBe(10);
      expect(stats.totalAnswered).toBe(3);
      expect(stats.totalNoAnswer).toBe(4);
      expect(stats.totalFailed).toBe(3);
      expect(stats.totalAbandoned).toBe(0);
      expect(stats.abandonmentRate).toBe(0);
    });
  });

  describe('Abandoned Call Detection', () => {
    it('should mark calls as ABANDONED', () => {
      const call = sm.createCall('b1', '+1', 'prov-a');
      sm.transition(call.id, CallEvent.RESERVE);
      sm.transition(call.id, CallEvent.INITIATE);
      sm.transition(call.id, CallEvent.RING);
      sm.transition(call.id, CallEvent.ANSWER);

      // Mark abandoned (no agent available)
      sm.markAbandoned(call.id);

      const final = sm.getCall(call.id)!;
      expect(final.disposition).toBe(CallDisposition.ABANDONED);
    });
  });
});
