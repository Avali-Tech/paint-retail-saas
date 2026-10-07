import { describe, expect, it } from 'vitest';
import { computeInvoice } from '../gst/invoice.js';
import { sampleInvoice, sampleInvoiceView } from './sample.js';
import { THERMAL_COLUMNS, renderThermalText, wrapText } from './thermal-text.js';
import { buildInvoiceView } from './view-model.js';

const widest = (text: string) => Math.max(...text.split('\n').map((line) => line.length));

describe('wrapText', () => {
  it('wraps on spaces, cuts words longer than a line and always gives a line', () => {
    expect(wrapText('Asian Paints Apex Ultima', 12)).toEqual(['Asian Paints', 'Apex Ultima']);
    expect(wrapText('ab cdefghijklmn op', 5)).toEqual(['ab', 'cdefg', 'hijkl', 'mn op']);
    expect(wrapText('abcdefghij', 5)).toEqual(['abcde', 'fghij']);
    expect(wrapText('  ', 5)).toEqual(['']);
  });
});

describe('renderThermalText', () => {
  it('prints a bill of supply to a walk-in customer in 48 columns', () => {
    const view = sampleInvoiceView({ kind: 'bill_of_supply', buyer: 'b2c', copy: null });

    expect(renderThermalText(view).split('\n')).toEqual([
      '            SHARMA PAINTS & HARDWARE',
      '   Sharma Paints and Hardware Private Limited',
      '          8-3-214, Ameerpet Main Road',
      '                Hyderabad 500016',
      '                 Telangana (36)',
      '             GSTIN: 36AAKFS4821M1ZR',
      '            Phone: +91 40 2373 4455',
      '',
      '                 BILL OF SUPPLY',
      '  Composition taxable person, not eligible to',
      '            collect tax on supplies',
      '------------------------------------------------',
      'Bill no. AMP/BS/26-27/045       Date 07 Oct 2026',
      'Place of supply: Telangana (36)',
      'Bill to: Walk-in customer',
      '------------------------------------------------',
      'Description                               Amount',
      '------------------------------------------------',
      '1. Asian Paints Apex Ultima 10 l',
      '   HSN 32091090',
      '   2 NOS x 6,450.00                    12,900.00',
      '2. Asian Paints Tractor Emulsion 4 l',
      '   HSN 32091090',
      '   3 NOS x 1,180.00                     3,363.00',
      '   Discount                              -177.00',
      '3. Birla Opus Wall Putty 20 kg',
      '   HSN 32141000',
      '   1 NOS x 980.00                         980.00',
      '4. Asian Paints Paint Brush 4 inch',
      '   HSN 96034020',
      '   2 NOS x 145.00                         290.00',
      '5. Roller with Handle 9 inch',
      '   HSN 96034090',
      '   1 NOS x 320.00                         320.00',
      '6. Masking Tape 24 mm',
      '   HSN 39191000',
      '   4 NOS x 55.00                          220.00',
      '------------------------------------------------',
      'Discount                                 -177.00',
      'Value                                  18,073.00',
      'Round off                                   0.00',
      '------------------------------------------------',
      'TOTAL                               Rs 18,073.00',
      '------------------------------------------------',
      'Rupees Eighteen Thousand Seventy-Three Only',
      '',
      'Notes:',
      'Goods once tinted cannot be returned.',
      '',
      'Terms and conditions:',
      'Payment due within 15 days.',
      'Subject to Hyderabad jurisdiction.',
      '',
      'For Sharma Paints and Hardware Private Limited',
      '',
      '',
      'Rajesh Sharma',
      'Authorised signatory',
    ]);
  });

  it('prints a B2B tax invoice with the copy mark, reverse charge, buyer and tax summary', () => {
    const text = renderThermalText(sampleInvoiceView());
    const lines = text.split('\n');

    expect(widest(text)).toBe(THERMAL_COLUMNS);
    expect(lines).toContain('                  TAX INVOICE');
    expect(lines).toContain('             ORIGINAL FOR RECIPIENT');
    expect(lines).toContain('Invoice no. AMP/26-27/00123     Date 07 Oct 2026');
    expect(lines).toContain('Whether tax is payable on reverse charge: No');
    expect(lines.slice(lines.indexOf('Bill to: Ravi Constructions'), -1).slice(0, 5)).toEqual([
      'Bill to: Ravi Constructions',
      'GSTIN: 36AAACT9876Q1Z9',
      'Plot 14, Madhapur',
      'Hyderabad 500081',
      'State: Telangana (36)',
    ]);
    expect(lines).toContain('Phone: +91 98480 12345');
    expect(lines).toContain('   HSN 32091090  GST 18%');
    expect(lines.slice(lines.indexOf('Tax summary'), lines.indexOf('Tax summary') + 3)).toEqual([
      'Tax summary',
      'Rate       Taxable           CGST           SGST',
      '18%      15,316.08       1,378.46       1,378.46',
    ]);
    expect(lines).toContain('CGST                                    1,378.46');
  });

  it('splits the tax summary between IGST and cess, and prints the ship-to address', () => {
    const { input, document } = sampleInvoice({ buyer: 'b2b_inter' });
    const view = buildInvoiceView(
      computeInvoice({
        ...input,
        rates: input.rates.map((rate) => ({ ...rate, cessBasisPoints: 100 })),
      }),
      {
        ...document,
        shipTo: { lines: ['Site 4, Baner'], city: 'Pune', pincode: null, stateCode: '27' },
      },
    );
    const lines = renderThermalText(view).split('\n');

    expect(lines).toContain('Ship to: Site 4, Baner, Pune');
    expect(lines).toContain('State: Maharashtra (27)');
    expect(lines).toContain('Rate       Taxable           IGST           Cess');
  });

  it('wraps what does not fit and leaves out what is not there', () => {
    const { input, document } = sampleInvoice({ kind: 'bill_of_supply', buyer: 'b2c' });
    const view = buildInvoiceView(computeInvoice(input), {
      ...document,
      number: 'AMP/BS/26-27/0045',
      supplier: {
        ...document.supplier,
        tradeName: null,
        legalName: 'Sharma Paints',
        phone: null,
      },
      lines: document.lines.map((line, index) => ({
        ...line,
        hsnCode: '',
        variant: index === 0 ? null : line.variant,
      })),
      notes: [],
      terms: [],
      signatoryName: null,
    });
    const text = renderThermalText(view, 32);
    const lines = text.split('\n');

    expect(widest(text)).toBeLessThanOrEqual(32);
    expect(lines.slice(0, 2)).toEqual(['         SHARMA PAINTS', '  8-3-214, Ameerpet Main Road']);
    expect(lines).toContain('Bill no. AMP/BS/26-27/0045');
    expect(lines).toContain('                Date 07 Oct 2026');
    expect(lines).toContain('1. Asian Paints Apex Ultima');
    expect(lines).not.toContain('Notes:');
    expect(lines.slice(-3)).toEqual(['', '', 'Authorised signatory']);
    expect(lines.some((line) => line.includes('HSN'))).toBe(false);
  });
});
