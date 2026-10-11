import { readFileSync } from 'node:fs';
import { sampleInvoiceView } from '@paint/shared';
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { embeddableImage, renderInvoicePdf } from './render-invoice-pdf.js';

/** The PDF's pages and their text, as a PDF reader extracts it. */
async function read(pdf: Buffer) {
  const document = await getDocumentProxy(new Uint8Array(pdf));
  const { totalPages, text } = await extractText(document);
  const info = (await document.getMetadata()).info as Record<string, unknown>;
  return { totalPages, text, title: info.Title };
}

const flat = (text: string) => text.replace(/\s+/g, ' ');

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('renderInvoicePdf', () => {
  it('draws a B2B tax invoice on one A4 page with every Rule 46 field', async () => {
    const pdf = await renderInvoicePdf(sampleInvoiceView());

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.subarray(-6).toString()).toContain('%%EOF');
    const { totalPages, text, title } = await read(pdf);
    const page = flat(text.join(' '));
    expect(totalPages).toBe(1);
    expect(title).toBe('Tax Invoice AMP/26-27/00123');
    for (const expected of [
      'Sharma Paints & Hardware',
      'Sharma Paints and Hardware Private Limited',
      'GSTIN: 36AAKFS4821M1ZR',
      'Tax Invoice',
      'ORIGINAL FOR RECIPIENT',
      'AMP/26-27/00123',
      '07 Oct 2026',
      'Telangana (36)',
      'Whether tax is payable on reverse charge',
      'Ravi Constructions',
      'GSTIN: 36AAACT9876Q1Z9',
      'Asian Paints Apex Ultima',
      '4 inch',
      '32091090',
      'CGST',
      'SGST',
      '983.90',
      'Tax summary',
      '15,316.08',
      'Round off',
      '₹18,073.00',
      'Rupees Eighteen Thousand Seventy-Three Only',
      'Goods once tinted cannot be returned.',
      'SBIN0020345',
      'UPI: sharmapaints@sbi',
      'For Sharma Paints and Hardware Private Limited',
      'Rajesh Sharma',
      'Authorised signatory',
      'Page 1 of 1',
    ]) {
      expect(page).toContain(expected);
    }
  });

  it('continues a long invoice over pages with the headings repeated', async () => {
    const view = sampleInvoiceView({ lineCount: 60, buyer: 'b2b_inter' });
    const { totalPages, text } = await read(await renderInvoicePdf(view));

    expect(totalPages).toBe(3);
    const [, second, third] = text.map(flat);
    expect(second).toContain('Tax Invoice AMP/26-27/00123 · Continued');
    expect(second).toContain('Description');
    expect(second).toContain('IGST');
    expect(second).toContain('Page 2 of 3');
    expect(third).toContain('Page 3 of 3');
    expect(third).toContain('Authorised signatory');
  });

  it('draws a bill of supply with the composition notice and no tax columns', async () => {
    const view = sampleInvoiceView({ kind: 'bill_of_supply', buyer: 'b2c', copy: null });
    const page = flat((await read(await renderInvoicePdf(view, { logo: PNG }))).text.join(' '));

    expect(page).toContain('Bill of Supply');
    expect(page).toContain('Composition taxable person, not eligible to collect tax on supplies');
    expect(page).toContain('Walk-in customer');
    expect(page).toContain('GSTIN: Unregistered');
    expect(page).not.toContain('CGST');
    expect(page).not.toContain('reverse charge');
    expect(page).not.toContain('ORIGINAL');
  });

  it('prints Hindi and Telugu labels under the English ones', async () => {
    const hindi = flat(
      (await read(await renderInvoicePdf(sampleInvoiceView({ secondLanguage: 'hi' })))).text.join(
        ' ',
      ),
    );
    const telugu = flat(
      (await read(await renderInvoicePdf(sampleInvoiceView({ secondLanguage: 'te' })))).text.join(
        ' ',
      ),
    );

    expect(hindi).toContain('Tax Invoice');
    expect(hindi).toContain('तारीख');
    expect(hindi).toContain('GST');
    expect(telugu).toContain('తేదీ');
    expect(telugu).toContain('Page 1 of 1పేజీ 1 / 1');
  });

  it('prints the ship-to address and leaves out what the shop did not give', async () => {
    const view = sampleInvoiceView({ buyer: 'b2c' });
    const page = flat(
      (
        await read(
          await renderInvoicePdf(
            {
              ...view,
              business: { ...view.business, name: view.supplier.legalName },
              supplier: { ...view.supplier, phone: null, email: null },
              buyer: { ...view.buyer, state: 'Telangana (36)', phone: '+91 90000 00001' },
              shipTo: { addressLines: ['Site 4, Kondapur'], state: 'Telangana (36)' },
              lines: view.lines.map((line) => ({ ...line, variant: null, discount: null })),
              notes: [],
              terms: [],
              bank: null,
              signatory: { ...view.signatory, name: null },
            },
            { logo: new Uint8Array([0x52, 0x49, 0x46, 0x46]) },
          ),
        )
      ).text.join(' '),
    );

    expect(page).toContain('Ship to');
    expect(page).toContain('Site 4, Kondapur');
    expect(page).toContain('Phone: +91 90000 00001');
    expect(page).not.toContain('Notes');
    expect(page).not.toContain('Bank details');
    expect(page).not.toContain('Rajesh Sharma');
  });

  it('moves what does not fit to the next page', async () => {
    const view = sampleInvoiceView();
    const { totalPages, text } = await read(
      await renderInvoicePdf({
        ...view,
        pricesIncludeTax: false,
        notes: Array.from({ length: 40 }, (_, index) => `Note ${String(index + 1)}`),
        bank: { ...view.bank, upiId: null } as typeof view.bank,
      }),
    );
    const [first, second] = text.map(flat);

    expect(totalPages).toBe(2);
    expect(first).toContain('Rate Discount');
    expect(first).not.toContain('Note 1 ');
    expect(second).toContain('Tax Invoice AMP/26-27/00123 · Continued');
    expect(second).toContain('Note 40');
    expect(second).toContain('Authorised signatory');
    expect(second).not.toContain('UPI');
  });

  it('draws with the bundled fonts, which are Noto under the OFL', () => {
    const licence = readFileSync(new URL('./fonts/OFL.txt', import.meta.url), 'utf8');

    expect(licence).toContain('SIL Open Font License, Version 1.1');
  });
});

describe('PDF helpers', () => {
  it('embeds only PNG and JPEG logos', () => {
    expect(embeddableImage(PNG)).toBe(true);
    expect(embeddableImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(embeddableImage(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBe(false);
    expect(embeddableImage(new Uint8Array([0x89, 0x50, 0x4e, 0x00]))).toBe(false);
    expect(embeddableImage(new Uint8Array([0xff, 0xd8, 0x00]))).toBe(false);
  });
});
