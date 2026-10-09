import { sampleInvoiceView, type InvoiceView } from '@paint/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InvoiceA4 } from './InvoiceA4.js';
import { InvoiceThermal } from './InvoiceThermal.js';

/** A sample with everything optional left out or changed. */
function sparse(): InvoiceView {
  const view = sampleInvoiceView({ buyer: 'b2c', copy: null, logoUrl: '/logo.png' });
  return {
    ...view,
    business: { ...view.business, name: view.supplier.legalName },
    supplier: { ...view.supplier, phone: null, email: null },
    buyer: {
      ...view.buyer,
      name: 'Lakshmi Devi',
      addressLines: ['House 9, Kukatpally'],
      state: 'Telangana (36)',
      phone: '+91 90000 00001',
    },
    shipTo: { addressLines: ['Site 4, Kondapur'], state: 'Telangana (36)' },
    pricesIncludeTax: false,
    lines: view.lines.map((line, index) => ({
      ...line,
      variant: index === 0 ? null : line.variant,
      hsn: index === 0 ? '' : line.hsn,
      discount: null,
      tint: index === 0 ? { shade: 'X 132', base: null, formula: null } : line.tint,
    })),
    notes: [],
    terms: [],
    bank: view.bank === null ? null : { ...view.bank, upiId: null },
    signatory: { ...view.signatory, name: null },
  };
}

describe('InvoiceA4', () => {
  it('prints the buyer’s state, phone and ship-to, and leaves out what is not given', () => {
    render(<InvoiceA4 view={sparse()} />);
    const a4 = screen.getByRole('article');

    expect(a4.querySelector('img')).toHaveAttribute('src', '/logo.png');
    expect(a4).toHaveTextContent('GSTIN: Unregistered');
    expect(a4).toHaveTextContent('State: Telangana (36)');
    expect(a4).toHaveTextContent('Phone: +91 90000 00001');
    expect(a4).toHaveTextContent('Ship toSite 4, KondapurTelangana (36)');
    expect(a4).not.toHaveTextContent('Notes');
    expect(a4).not.toHaveTextContent('Terms and conditions');
    expect(a4).not.toHaveTextContent('UPI');
    expect(a4).not.toHaveTextContent('Rajesh Sharma');
    const headings = within(screen.getByRole('table', { name: 'Description' }))
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    expect(headings).toEqual([
      'Sharma Paints and Hardware Private Limited · Tax Invoice AMP/26-27/00123',
      '#',
      'Description',
      'HSN',
      'Qty',
      'Rate',
      'Taxable value',
      'GST %',
      'CGST',
      'SGST',
      'Amount',
    ]);
    // A tint without a base or formula prints its shade alone.
    expect(a4.querySelector('.invoice__tint')).toHaveTextContent(/^Tint: X 132$/);
  });

  it('prints a tinted line’s shade, base and formula under it', () => {
    render(<InvoiceA4 view={sampleInvoiceView()} />);
    const tints = screen.getByRole('article').querySelectorAll('.invoice__tint');
    expect([...tints].map((tint) => tint.textContent)).toEqual([
      'Tint: X 132 · Ivory Mist · Base: Apex Ultima Pastel Base · Formula: XY 12 ml, R 3 shot',
    ]);
  });

  it('prints a bill of supply without a tax summary', () => {
    render(<InvoiceA4 view={sampleInvoiceView({ kind: 'bill_of_supply', buyer: 'b2c' })} />);

    expect(screen.queryByRole('table', { name: 'Tax summary' })).toBeNull();
    expect(screen.getByRole('article')).toHaveTextContent('Bill no.AMP/BS/26-27/045');
  });
});

describe('InvoiceThermal', () => {
  it('prints the buyer’s details and ship-to, and lines without HSN or size', () => {
    render(<InvoiceThermal view={sparse()} />);
    const receipt = screen.getByRole('article');
    const items = within(screen.getByRole('list', { name: 'Description' })).getAllByRole(
      'listitem',
    );

    expect(receipt).toHaveTextContent('House 9, KukatpallyTelangana (36)+91 90000 00001');
    expect(receipt).toHaveTextContent('Ship toSite 4, Kondapur, Telangana (36)');
    expect(items[0]).toHaveTextContent(
      /^1\. Asian Paints Apex UltimaGST 18%Tint X 1322 NOS × 6,450.0012,900.00$/,
    );
    expect(receipt).not.toHaveTextContent('Rajesh Sharma');
  });

  it('prints a tinted line’s shade and formula on one short line', () => {
    render(<InvoiceThermal view={sampleInvoiceView()} />);
    const tints = screen.getByRole('article').querySelectorAll('.receipt__tint');
    expect([...tints].map((tint) => tint.textContent)).toEqual([
      'Tint X 132 · Ivory Mist · XY 12 ml, R 3 shot',
    ]);
  });

  it('prints a bill of supply without tax rates or a tax summary', () => {
    render(<InvoiceThermal view={sampleInvoiceView({ kind: 'bill_of_supply', buyer: 'b2c' })} />);

    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getAllByRole('listitem')[1]).toHaveTextContent(
      '2. Asian Paints Tractor Emulsion 4 lHSN 320910903 NOS × 1,180.003,363.00Discount-177.00',
    );
  });
});
