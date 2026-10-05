import { describe, expect, it } from 'vitest';
import { createI18n } from '../i18n/i18n.js';
import { filterChoices, filterLabel, reportText } from './report-filters.js';

const i18n = createI18n('en');

describe('report filters', () => {
  it('offers the values of each choice filter', () => {
    expect(filterChoices(i18n, 'stock-ledger', 'movementType')?.[1]).toEqual({
      value: 'purchase_receipt',
      label: 'Purchase receipt',
    });
    expect(filterChoices(i18n, 'transfers', 'status')?.[2]).toEqual({
      value: 'in_transit',
      label: 'In transit',
    });
    expect(filterChoices(i18n, 'leads', 'stage')?.map((choice) => choice.value)).toEqual([
      'new',
      'contacted',
      'qualified',
      'opportunity',
      'won',
      'lost',
    ]);
    expect(filterChoices(i18n, 'projects', 'stage')?.[0]).toEqual({
      value: 'identified',
      label: 'Identified',
    });
    expect(filterChoices(i18n, 'leads', 'source')?.[0]).toEqual({
      value: 'walk_in',
      label: 'Walk-in',
    });
    expect(filterChoices(i18n, 'leads', 'from')).toBeNull();
  });

  it('names filters and reports, falling back to the API for new ones', () => {
    expect(filterLabel(i18n.t, 'storeId')).toBe('Store');
    expect(filterLabel(i18n.t, 'paymentMode')).toBe('PaymentMode');
    expect(reportText(i18n.t, { kind: 'stock-ledger', title: 'x' })).toEqual({
      title: 'Stock ledger',
      description: 'Every stock movement with who made it, newest first',
    });
    expect(reportText(i18n.t, { kind: 'sales', title: 'Sales by day' })).toEqual({
      title: 'Sales by day',
      description: null,
    });
  });
});
