// ─── Borrower Queue (atomic lead allocation) ────────────────────────────────
import { Borrower, BorrowerStatus } from '../types/call.js';
import { v4 as uuidv4 } from 'uuid';

export class BorrowerClaimConflictError extends Error {
  constructor(
    public readonly borrowerId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number
  ) {
    super(
      `CAS conflict on borrower ${borrowerId}: expected version ${expectedVersion}, found ${actualVersion}`
    );
    this.name = 'BorrowerClaimConflictError';
  }
}

/**
 * Priority lead queue with Compare-And-Swap claims.
 *
 * Two workers seeing the same READY borrower cannot both claim it:
 *   Worker A: claim(id, version=3) → SUCCESS, version=4, status=CLAIMED
 *   Worker B: claim(id, version=3) → CONFLICT
 */
export class BorrowerQueue {
  private borrowers: Map<string, Borrower> = new Map();

  seed(count: number, maxAttempts: number = 3): Borrower[] {
    const created: Borrower[] = [];
    for (let i = 0; i < count; i++) {
      created.push(this.addBorrower({
        name: `Borrower-${i + 1}`,
        phoneNumber: `+1${String(2000000000 + i).padStart(10, '0')}`,
        accountId: `acct-${i + 1}`,
        priority: (i % 5) + 1,
        timezone: 'America/New_York',
        maxAttempts,
      }));
    }
    return created;
  }

  addBorrower(partial: {
    name: string;
    phoneNumber: string;
    accountId: string;
    priority?: number;
    timezone?: string;
    maxAttempts?: number;
  }): Borrower {
    const borrower: Borrower = {
      id: uuidv4(),
      name: partial.name,
      phoneNumber: partial.phoneNumber,
      accountId: partial.accountId,
      priority: partial.priority ?? 1,
      timezone: partial.timezone ?? 'UTC',
      lastDialedAt: null,
      dialAttempts: 0,
      maxAttempts: partial.maxAttempts ?? 3,
      status: BorrowerStatus.READY,
      version: 0,
      claimedByWorkerId: null,
      claimedAt: null,
    };
    this.borrowers.set(borrower.id, borrower);
    return { ...borrower };
  }

  /**
   * Atomically claim the highest-priority READY borrower.
   * Duplicate jobs cannot claim the same lead.
   */
  claimNext(workerId: string): Borrower | null {
    const ready = Array.from(this.borrowers.values())
      .filter((b) => b.status === BorrowerStatus.READY)
      .sort((a, b) => b.priority - a.priority || a.dialAttempts - b.dialAttempts);

    for (const borrower of ready) {
      try {
        return this.claim(borrower.id, borrower.version, workerId);
      } catch (err) {
        if (err instanceof BorrowerClaimConflictError) continue;
        throw err;
      }
    }
    return null;
  }

  claim(borrowerId: string, expectedVersion: number, workerId: string): Borrower {
    const borrower = this.borrowers.get(borrowerId);
    if (!borrower) {
      throw new Error(`Borrower ${borrowerId} not found`);
    }
    if (borrower.version !== expectedVersion) {
      throw new BorrowerClaimConflictError(borrowerId, expectedVersion, borrower.version);
    }
    if (borrower.status !== BorrowerStatus.READY) {
      throw new BorrowerClaimConflictError(borrowerId, expectedVersion, borrower.version);
    }

    borrower.status = BorrowerStatus.CLAIMED;
    borrower.version += 1;
    borrower.claimedByWorkerId = workerId;
    borrower.claimedAt = Date.now();
    borrower.dialAttempts += 1;
    borrower.lastDialedAt = Date.now();
    return { ...borrower };
  }

  markInCall(borrowerId: string): void {
    const borrower = this.borrowers.get(borrowerId);
    if (borrower && borrower.status === BorrowerStatus.CLAIMED) {
      borrower.status = BorrowerStatus.IN_CALL;
      borrower.version += 1;
    }
  }

  /**
   * Call connected and completed — borrower is done for this campaign.
   */
  complete(borrowerId: string): void {
    const borrower = this.borrowers.get(borrowerId);
    if (!borrower) return;
    borrower.status = BorrowerStatus.COMPLETED;
    borrower.version += 1;
    borrower.claimedByWorkerId = null;
    borrower.claimedAt = null;
  }

  /**
   * Failed / no-answer / cancelled: retry later or exhaust.
   */
  releaseForRetry(borrowerId: string): void {
    const borrower = this.borrowers.get(borrowerId);
    if (!borrower) return;

    borrower.claimedByWorkerId = null;
    borrower.claimedAt = null;
    borrower.version += 1;

    if (borrower.dialAttempts >= borrower.maxAttempts) {
      borrower.status = BorrowerStatus.EXHAUSTED;
    } else {
      borrower.status = BorrowerStatus.READY;
    }
  }

  getBorrower(borrowerId: string): Borrower | undefined {
    const b = this.borrowers.get(borrowerId);
    return b ? { ...b } : undefined;
  }

  getReadyCount(): number {
    return Array.from(this.borrowers.values()).filter((b) => b.status === BorrowerStatus.READY).length;
  }

  getStats() {
    const stats = { total: this.borrowers.size, ready: 0, claimed: 0, inCall: 0, completed: 0, exhausted: 0 };
    for (const b of this.borrowers.values()) {
      switch (b.status) {
        case BorrowerStatus.READY: stats.ready++; break;
        case BorrowerStatus.CLAIMED: stats.claimed++; break;
        case BorrowerStatus.IN_CALL: stats.inCall++; break;
        case BorrowerStatus.COMPLETED: stats.completed++; break;
        case BorrowerStatus.EXHAUSTED: stats.exhausted++; break;
      }
    }
    return stats;
  }

  reset(): void {
    this.borrowers.clear();
  }
}
