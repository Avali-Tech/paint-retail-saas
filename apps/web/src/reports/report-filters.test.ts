import { describe, expect, it } from 'vitest';
import { createI18n } from '../i18n/i18n.js';
import { cellText, filterChoices, filterLabel, reportText } from './report-filters.js';

const i18n = createI18n('en');
const choice = (name: string, values: string[]) =>
  filterChoices(i18n, { name, type: 'enum', values });

describe('report filters', () => {
  it('names the values the API lists for each choice filter', () => {
    expect(choice('movementType', ['opening', 'purchase_receipt'])).toEqual([
      { value: 'opening', label: 'Opening stock' },
      { value: 'purchase_receipt', label: 'Purchase receipt' },
    ]);
    expect(choice('status', ['in_transit'])).toEqual([
      { value: 'in_transit', label: 'In transit' },
    ]);
    expect(choice('stage', ['qualified', 'identified', 'brand_new'])).toEqual([
      { value: 'qualified', label: 'Qualified' },
      { value: 'identified', label: 'Identified' },
      { value: 'brand_new', label: 'Brand new' },
    ]);
    expect(choice('source', ['walk_in'])).toEqual([{ value: 'walk_in', label: 'Walk-in' }]);
    expect(choice('groupBy', ['customer', 'salesperson', 'store'])).toEqual([
      { value: 'customer', label: 'Customer' },
      { value: 'salesperson', label: 'Salesperson' },
      { value: 'store', label: 'Store' },
    ]);
    expect(choice('schemeStatus', ['active', 'closed'])).toEqual([
      { value: 'active', label: 'Running' },
      { value: 'closed', label: 'Closed' },
    ]);
    // A filter the app does not know yet: its values humanized.
    expect(choice('channel', ['walk_in'])).toEqual([{ value: 'walk_in', label: 'Walk in' }]);
    expect(filterChoices(i18n, { name: 'from', type: 'date' })).toEqual([]);
  });

  it('names filters and reports, falling back to the API for new ones', () => {
    expect(filterLabel(i18n.t, 'storeId')).toBe('Store');
    expect(filterLabel(i18n.t, 'asOf')).toBe('As of');
    expect(reportText(i18n.t, { kind: 'receivables-ageing', title: 'x' }).title).toBe(
      'Receivables ageing',
    );
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

  it('names the sales reports’ choices', () => {
    expect(choice('interval', ['week']).map((c) => c.label)).toEqual(['Week']);
    expect(choice('kind', ['bill_of_supply']).map((c) => c.label)).toEqual(['Bill of supply']);
    expect(choice('buyerType', ['b2b', 'b2c']).map((c) => c.label)).toEqual([
      'B2B (buyer has a GSTIN)',
      'B2C',
    ]);
    expect(choice('customerType', ['builder']).map((c) => c.label)).toEqual(['Builder']);
    expect(choice('modeKind', ['upi_link']).map((c) => c.label)).toEqual(['UPI link']);
    expect(filterLabel(i18n.t, 'customerSalespersonId')).toBe('Customer’s salesperson');
  });

  it('reads coded cells by their names, and other cells as they are', () => {
    expect(cellText(i18n, 'gst-summary.section', 'nil_rated')).toBe('Nil rated');
    expect(cellText(i18n, 'gst-summary.supplyType', 'inter_state')).toBe('To another state');
    expect(cellText(i18n, 'payments-by-mode.modeKind', 'cheque')).toBe('Cheque');
    expect(cellText(i18n, 'gst-summary.gstin', '36AABCS1429B1Z5')).toBe('36AABCS1429B1Z5');
  });
});
