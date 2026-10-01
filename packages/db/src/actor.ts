import { AsyncLocalStorage } from 'node:async_hooks';

const actor = new AsyncLocalStorage<string>();

/**
 * Runs `work` on behalf of a member: every tenant transaction it opens records
 * them as the actor, so the audit log knows who made each change.
 */
export function runAsMember<T>(memberId: string, work: () => T): T {
  return actor.run(memberId, work);
}

/** The member the current work runs for, if any (none for system work). */
export function currentActor(): string | undefined {
  return actor.getStore();
}
