import { SETUP_STEP_KEYS } from '@paint/shared';
import { describe, expect, it } from 'vitest';
import { STEP_PATHS, dismiss, isDismissed } from './checklist.js';

const broken = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
} as unknown as Storage;

describe('getting started checklist', () => {
  it('links every step to a screen', () => {
    for (const key of SETUP_STEP_KEYS) expect(STEP_PATHS[key]).toMatch(/^\//);
  });

  it('remembers on this device, per business, that it was hidden', () => {
    localStorage.clear();
    expect(isDismissed(localStorage, 'org-1')).toBe(false);
    dismiss(localStorage, 'org-1');
    expect(isDismissed(localStorage, 'org-1')).toBe(true);
    expect(isDismissed(localStorage, 'org-2')).toBe(false);
  });

  it('shows the checklist when storage fails', () => {
    expect(() => {
      dismiss(broken, 'org-1');
    }).not.toThrow();
    expect(isDismissed(broken, 'org-1')).toBe(false);
  });
});
