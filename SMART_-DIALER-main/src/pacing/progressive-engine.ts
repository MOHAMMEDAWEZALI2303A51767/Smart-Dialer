// ─── Progressive Pacing Engine (Deterministic 1:1) ──────────────────────────
import { DialProposal } from '../types/call.js';
import { AgentStateMachine } from '../state-machine/agent-state-machine.js';
import { CallStateMachine } from '../state-machine/call-state-machine.js';

/**
 * ProgressiveEngine implements a conservative 1:1 dialing strategy.
 *
 * Rule: Place exactly ONE outbound call for each AVAILABLE agent.
 * This guarantees ZERO abandoned calls because every answered call
 * has a pre-assigned agent waiting.
 *
 * Trade-off: Lower agent utilization due to ring-wait idle time,
 * but perfect compliance and zero risk of abandoned calls.
 */
export class ProgressiveEngine {
  constructor(
    private agentSM: AgentStateMachine,
    private callSM: CallStateMachine
  ) {}

  /**
   * Generate a dial proposal based on current state.
   * Returns the number of calls to initiate = number of available agents
   * minus currently ringing calls that don't yet have an agent match.
   */
  propose(): DialProposal {
    const availableAgents = this.agentSM.getAvailableCount();
    const currentRinging = this.callSM.getCurrentRingingCount();

    // In progressive mode: dial only when agents are free and waiting
    // Each dial is pre-matched to a specific agent.
    const dialCount = Math.max(0, availableAgents - currentRinging);

    return {
      requestedDials: dialCount,
      reason: `Progressive 1:1 — ${availableAgents} agents available, ${currentRinging} already ringing. ` +
        `Proposing ${dialCount} new dials (one per idle agent).`,
      pacingMode: 'PROGRESSIVE',
    };
  }
}
