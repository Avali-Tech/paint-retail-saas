import { describe, expect, it } from 'vitest';
import { stateLabel } from './gst-states.js';

describe('stateLabel', () => {
  it('names a GST state after its code', () => {
    expect(stateLabel('36')).toBe('36 · Telangana');
  });

  it('shows an unknown code as it is', () => {
    expect(stateLabel('99')).toBe('99');
  });
});
