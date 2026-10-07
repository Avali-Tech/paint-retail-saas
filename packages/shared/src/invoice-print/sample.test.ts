import { describe, expect, it } from 'vitest';
import { renderThermalText } from './thermal-text.js';
import { sampleInvoiceView } from './sample.js';

describe('sampleInvoiceView', () => {
  it('carries the white-label business name and logo it is given', () => {
    const printed = sampleInvoiceView({ businessName: 'Sri Balaji Paints', logoUrl: '/logo/1' });

    expect(printed.business).toEqual({ name: 'Sri Balaji Paints', logoUrl: '/logo/1' });
    expect(renderThermalText(printed).split('\n')[0]).toBe('               SRI BALAJI PAINTS');
  });

  it('repeats the items for a long invoice', () => {
    const printed = sampleInvoiceView({ lineCount: 40 });

    expect(printed.lines).toHaveLength(40);
    expect(printed.lines[39]?.serial).toBe(40);
    expect(printed.lines[6]?.description).toBe('Asian Paints Apex Ultima');
  });
});
