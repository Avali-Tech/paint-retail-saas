import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/i18n.js';
import { IdentityProvider } from '../theme/IdentityProvider.js';
import { lineTintView } from '../tint/test-support/tint-fixtures.js';
import { product, variant } from '../test-support/inventory-fixtures.js';
import { billReducer, newBill } from './bill.js';
import { printViewOf } from './print-view.js';
import { PrintSlot } from './PosPrint.js';
import { previewBill, ratesFrom, type Preview } from './preview.js';
import { TotalsPanel } from './TotalsPanel.js';
import {
  AP_GSTIN,
  ISSUED,
  OPTIONS,
  TS_GSTIN,
  draftLine,
  item,
} from './test-support/pos-fixtures.js';
import { PRODUCTS, renderPos, scanBox, searchIn } from './test-support/pos-render.js';

const print = vi.fn();
beforeEach(() => {
  print.mockClear();
  vi.spyOn(window, 'print').mockImplementation(print);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const context = {
  storeGstin: TS_GSTIN,
  rates: ratesFrom(OPTIONS, '2026-10-08'),
  today: '2026-10-08',
};
const oneLine = billReducer(newBill('b'), { type: 'add', item: item(), quantity: 1 });

function totals(preview: Preview, exclusive = false) {
  return render(
    <I18nProvider locale="en">
      <TotalsPanel
        preview={preview}
        lineCount={1}
        exclusive={exclusive}
        holding={false}
        onHold={() => undefined}
        onPay={() => undefined}
      />
    </I18nProvider>,
  );
}

describe('TotalsPanel', () => {
  it('says why there is no tax breakup, and how prices are taxed', () => {
    totals({ ok: false, reason: 'invalid_amount', payablePaise: 100 }, true);
    expect(screen.getByText('The GST is worked out when the bill is issued.')).toBeInTheDocument();
    expect(screen.getByText('GST added to prices')).toBeInTheDocument();
  });

  it('names a composition sale to another state, and a bill of supply', () => {
    const { unmount } = totals({ ok: false, reason: 'composition_inter_state', payablePaise: 1 });
    expect(
      screen.getByText('A composition store cannot sell to another state.'),
    ).toBeInTheDocument();
    unmount();
    totals(previewBill({ ...oneLine, kind: 'bill_of_supply' }, context));
    expect(screen.getByText('Bill of supply: no GST shown')).toBeInTheDocument();
  });
});

describe('printViewOf', () => {
  it('prints an issued counter bill with the engine’s figures and no copy mark', () => {
    const view = printViewOf(ISSUED, null, null);
    expect(view).toMatchObject({
      kind: 'tax_invoice',
      number: 'AMP/26-27/000001',
      copyMark: null,
      supplyType: 'intra_state',
      business: { name: 'Sharma Paints' },
      buyer: { name: 'Walk-in customer', gstin: null, addressLines: [] },
    });
    expect(view.lines.map((line) => [line.description, line.hsn, line.uqc])).toEqual([
      ['Asian Paints Apex Ultima 20 l', '3209', 'LTR'],
    ]);
    expect(view.grandTotal).toContain('10,450.00');
  });

  it('prints a B2B inter-state bill with discounts, and a bill of supply', () => {
    const line = draftLine({
      description: 'Asian Paints Apex Ultima 20 l',
      hsnCode: '3209',
      uqc: 'LTR',
      rateBps: 1800,
      taxNature: 'taxable',
    });
    const b2b = printViewOf(
      {
        ...ISSUED,
        placeOfSupplyCode: '37',
        supplyType: 'inter_state',
        billDiscountPaise: 100,
        supplier: { ...ISSUED.supplier, address: null },
        buyer: {
          partyId: 'p',
          name: 'Rao Builders',
          gstin: AP_GSTIN,
          address: 'Guntur',
          stateCode: null,
        },
        lines: [
          { ...line, discountBps: 500 },
          { ...line, id: 'l2', lineNo: 2, rateBps: 1200, discountPaise: 1000 },
        ],
      },
      'hi',
      null,
    );
    expect(b2b).toMatchObject({
      supplyType: 'inter_state',
      secondLanguage: 'hi',
      buyer: { gstin: AP_GSTIN, addressLines: ['Guntur'] },
      supplier: { addressLines: [] },
    });
    expect(b2b.lines).toHaveLength(2);
    const supply = printViewOf(
      {
        ...ISSUED,
        kind: 'bill_of_supply',
        buyer: { ...ISSUED.buyer, name: 'Sita', address: 'Ameerpet', stateCode: '36' },
        lines: [{ ...line, rateBps: null, taxNature: null }],
      },
      null,
      null,
    );
    expect(supply).toMatchObject({ kind: 'bill_of_supply', buyer: { name: 'Sita' } });
  });

  it('prints exempt and nil-rated 0% lines apart, as the issue recorded them', () => {
    const zero = (id: string, taxNature: 'exempt' | 'nil_rated') =>
      draftLine({
        id,
        description: id,
        hsnCode: '49111010',
        uqc: 'PCS',
        unitPricePaise: 1_000,
        rateBps: 0,
        taxNature,
      });
    const view = printViewOf(
      { ...ISSUED, lines: [zero('Shade card', 'exempt'), zero('Sample', 'nil_rated')] },
      null,
      null,
    );
    expect(view.lines.map((line) => line.rate)).toEqual(['Exempt', 'Nil rated']);
    expect(view.taxSummary.map((row) => row.rate)).toEqual(['Exempt', 'Nil rated']);
  });

  it('prints the logo, the settings’ bank details and terms, the turnover’s HSN rule and tints', () => {
    const bank = {
      bankName: 'HDFC Bank',
      accountName: 'Sharma Paints LLP',
      accountNumber: '50100123456789',
      ifsc: 'HDFC0001234',
      upiId: 'sharma@hdfc',
    };
    const tinted = {
      ...ISSUED,
      print: {
        bank,
        terms: ['No returns on tinted paint.'],
        aggregateTurnoverPaise: 5_00_00_000_01,
      },
      lines: ISSUED.lines.map((line) => ({
        ...line,
        tint: lineTintView({
          shadeCode: 'X 132',
          shadeName: 'Ivory Mist',
          formula: [{ colorant: 'XY', amount: 12, unit: 'ml' }],
        }),
      })),
    };
    const view = printViewOf(tinted, null, '/api/public/branding/sharma/logo/abc');
    expect(view.business.logoUrl).toBe('/api/public/branding/sharma/logo/abc');
    expect(view.bank).toEqual(bank);
    expect(view.terms).toEqual(['No returns on tinted paint.']);
    // Above ₹5 crore even a B2C bill needs 6 HSN digits: this bill's 4 are short.
    expect(view.requirements.hsnDigits).toBe(6);
    expect(view.issues).toEqual([{ code: 'hsn_digits', clause: '46(g)', line: 0 }]);
    expect(view.lines[0]?.tint).toEqual({
      shade: 'X 132 · Ivory Mist',
      base: 'Asian Paints Apex Ultima 20 l',
      formula: 'XY 12 ml',
    });
  });
});

describe('PrintSlot', () => {
  it('prints in the member’s language under the English labels', () => {
    const logo = {
      url: '/public/branding/sharma/logo/abc',
      contentType: 'image/png',
      width: 200,
      height: 80,
      sizeBytes: 1000,
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    const identity = { slug: 'sharma', logo };
    const load = () => Promise.resolve(identity);
    const { container } = render(
      <IdentityProvider
        source={{
          cached: () => identity,
          load,
          saveSlug: load,
          uploadLogo: load,
          removeLogo: load,
          assetUrl: (path) => `/api${path}`,
        }}
        sessionKey={null}
      >
        <I18nProvider locale="te">
          <PrintSlot job={{ id: 1, invoice: ISSUED, format: 'a4' }} />
        </I18nProvider>
      </IdentityProvider>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(document.querySelector('img.invoice__logo')).toHaveAttribute(
      'src',
      '/api/public/branding/sharma/logo/abc',
    );
    expect(screen.getByTestId('print-layer')).toHaveAttribute('data-format', 'a4');
    expect(screen.getByRole('article', { name: /AMP\/26-27\/000001/ })).toBeInTheDocument();
    expect(print).toHaveBeenCalledTimes(1);
  });
});

describe('PosPage: the rest of the keyboard and buttons', () => {
  it('F2 goes to the scan box, the Hold button holds, focus selects a line, modes switch per row', async () => {
    const OLD = product({
      id: 'product-old',
      name: 'Old Roller',
      isActive: false,
      variants: [variant({ id: 'v-old', sku: 'OLD-1', barcodes: [] })],
    });
    const { user } = renderPos({ 'GET /products': searchIn([...PRODUCTS, OLD]) });
    const box = await scanBox();
    // A product no longer sold is not offered by the name search.
    await user.type(box, 'roller{Enter}');
    const results = await screen.findByRole('listbox', { name: 'Matching products' });
    expect(within(results).getAllByRole('option')).toHaveLength(2);
    await user.keyboard('{Enter}');
    await user.type(box, 'APX-20L{Enter}');
    // One match by name is added at once.
    await user.type(box, 'wall{Enter}');
    await screen.findByRole('listitem', { name: 'Asian Paints Wall Putty 20 kg' });
    await screen.findByRole('listitem', { name: 'Asian Paints Apex Ultima 20 l' });
    await user.click(
      screen.getByRole('textbox', { name: 'Quantity of Asian Paints Roller 9 inch' }),
    );
    expect(screen.getByRole('listitem', { name: 'Asian Paints Roller 9 inch' })).toHaveAttribute(
      'data-selected',
    );
    await user.keyboard('{F2}');
    expect(box).toHaveFocus();

    await user.keyboard('{F8}');
    const dialog = await screen.findByRole('dialog', { name: 'Payment' });
    await user.click(within(dialog).getByRole('button', { name: 'Add a payment' }));
    const second = within(dialog).getByRole('radiogroup', { name: 'Mode of payment 2' });
    await user.click(within(second).getByRole('radio', { name: 'Card' }));
    expect(within(second).getByRole('radio', { name: 'Card' })).toBeChecked();
    expect(
      within(within(dialog).getByRole('radiogroup', { name: 'Mode of payment 1' })).getByRole(
        'radio',
        { name: 'Cash' },
      ),
    ).toBeChecked();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Hold (F4)' }));
    expect(await screen.findByText('Bill held')).toBeInTheDocument();
  });
});
