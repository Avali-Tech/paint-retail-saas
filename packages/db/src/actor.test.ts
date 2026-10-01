import { describe, expect, it } from 'vitest';
import { currentActor, runAsMember } from './actor.js';

describe('runAsMember', () => {
  it('makes the member the actor for everything the work does, even after awaits', async () => {
    expect(currentActor()).toBeUndefined();

    const seen = await runAsMember('member-1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentActor();
    });

    expect(seen).toBe('member-1');
    expect(currentActor()).toBeUndefined();
  });

  it('keeps concurrent work apart', async () => {
    const seen = await Promise.all(
      ['a', 'b'].map((id) =>
        runAsMember(id, async () => {
          await new Promise((resolve) => setTimeout(resolve, id === 'a' ? 5 : 1));
          return currentActor();
        }),
      ),
    );

    expect(seen).toEqual(['a', 'b']);
  });
});
