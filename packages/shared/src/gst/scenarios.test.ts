import { describe, expect, it } from 'vitest';
import { computeInvoice, computeReturn } from '../index.js';
import { INVOICE_SCENARIOS, RETURN_SCENARIOS } from './scenarios.js';

describe('CA-reviewed invoice scenarios', () => {
  it.each(INVOICE_SCENARIOS)('$id $title', ({ input, expected }) => {
    const invoice = computeInvoice(input);
    const { lines, taxSummary, ...rest } = expected;
    expect(invoice).toMatchObject(rest);
    expect(invoice.lines).toHaveLength(lines.length);
    lines.forEach((line, index) => {
      expect(invoice.lines[index]).toMatchObject(line);
    });
    if (taxSummary) expect(invoice.taxSummary).toMatchObject(taxSummary);
  });

  it('has unique ids and a working note on every scenario', () => {
    const ids = INVOICE_SCENARIOS.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(INVOICE_SCENARIOS.every(({ working }) => working.length > 0)).toBe(true);
  });
});

describe('CA-reviewed return scenarios', () => {
  const invoiceFor = (id: string) => {
    const scenario = INVOICE_SCENARIOS.find((candidate) => candidate.id === id);
    if (!scenario) throw new Error(`No scenario ${id}`);
    return computeInvoice(scenario.input);
  };

  it.each(RETURN_SCENARIOS)('$id $title', ({ invoiceId, returned, roundOff, expected }) => {
    const note = computeReturn(invoiceFor(invoiceId), returned, roundOff);
    expect(note.totals).toMatchObject(expected.totals);
    expect(note.lines).toMatchObject(expected.lines);
  });

  it('the three single-unit notes R01–R03 reverse S12 line 3 exactly', () => {
    const original = invoiceFor('S12').lines[2];
    const notes = RETURN_SCENARIOS.filter(({ id }) => ['R01', 'R02', 'R03'].includes(id)).map(
      ({ returned }) => computeReturn(invoiceFor('S12'), returned, false).totals,
    );
    const sum = (key: 'taxablePaise' | 'cgstPaise' | 'sgstPaise') =>
      notes.reduce((total, note) => total + note[key], 0);
    expect({
      taxablePaise: sum('taxablePaise'),
      cgstPaise: sum('cgstPaise'),
      sgstPaise: sum('sgstPaise'),
    }).toEqual({
      taxablePaise: original?.taxablePaise,
      cgstPaise: original?.cgstPaise,
      sgstPaise: original?.sgstPaise,
    });
  });
});
