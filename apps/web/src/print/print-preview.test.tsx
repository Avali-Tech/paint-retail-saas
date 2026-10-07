import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OWNER, json } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';

function renderPreview() {
  return renderApp({ path: '/print-preview', routes: { 'GET /auth/me': () => json(OWNER) } });
}

const invoice = (name: RegExp) => screen.getByRole('article', { name });

describe('PrintPreviewPage', () => {
  it('shows a sample A4 tax invoice in the business’s name and prints it', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const { user } = renderPreview();
    await screen.findByRole('heading', { name: 'Invoice print preview', level: 1 });

    const a4 = invoice(/Tax Invoice AMP\/26-27\/00123/);
    expect(a4).toHaveClass('invoice--a4');
    expect(within(a4).getByText('Paint Retail', { selector: '.invoice__business' })).toBeVisible();
    expect(a4).toHaveTextContent('ORIGINAL FOR RECIPIENT');
    expect(a4).toHaveTextContent('Whether tax is payable on reverse charge');
    expect(a4).toHaveTextContent('GSTIN: 36AAACT9876Q1Z9');
    expect(a4).toHaveTextContent('Rupees Eighteen Thousand Seventy-Three Only');
    expect(a4).toHaveTextContent('₹18,073.00');
    const items = within(a4).getByRole('table', { name: 'Description' });
    expect(within(items).getAllByRole('row')).toHaveLength(8);
    expect(
      within(items).getByRole('rowheader', { name: 'Asian Paints Paint Brush 4 inch' }),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalledOnce();
    print.mockRestore();
  });

  it('switches paper, sample, second language, copy mark and length', async () => {
    const { user } = renderPreview();
    const options = await screen.findByRole('form', { name: 'Preview options' });
    const choose = (name: string, option: string) =>
      user.selectOptions(within(options).getByRole('combobox', { name }), option);

    await choose('Paper', 'Thermal 80 mm');
    const receipt = invoice(/Tax Invoice/);
    expect(receipt).toHaveClass('invoice--thermal');
    expect(receipt).toHaveTextContent('HSN 32091090 · GST 18%');

    await choose('Sample', 'Bill of supply (composition dealer)');
    const bill = invoice(/Bill of Supply AMP\/BS\/26-27\/045/);
    expect(bill).toHaveTextContent(
      'Composition taxable person, not eligible to collect tax on supplies',
    );
    expect(bill).toHaveTextContent('Walk-in customer');

    await choose('Second language on the invoice', 'తెలుగు');
    expect(within(invoice(/Bill of Supply/)).getByText('బిల్ ఆఫ్ సప్లై')).toHaveAttribute(
      'lang',
      'te',
    );
    await choose('Copy mark', 'None');
    expect(invoice(/Bill of Supply/)).not.toHaveTextContent('ORIGINAL');
    await choose('Copy mark', 'Duplicate for transporter');
    expect(invoice(/Bill of Supply/)).toHaveTextContent('DUPLICATE FOR TRANSPORTER');

    await choose('Paper', 'A4');
    await choose('Sample', 'Registered buyer, other state');
    await user.click(within(options).getByRole('checkbox', { name: 'Long invoice (40 lines)' }));
    const long = invoice(/Tax Invoice/);
    await waitFor(() => {
      expect(within(long).getAllByRole('row').length).toBeGreaterThan(40);
    });
    expect(long).toHaveTextContent('IGST');
    expect(long).toHaveTextContent('Maharashtra (27)');

    await choose('Sample', 'Walk-in customer');
    await choose('Second language on the invoice', 'हिन्दी');
    expect(within(invoice(/Tax Invoice/)).getByText('टैक्स इनवॉइस')).toHaveAttribute('lang', 'hi');
    await choose('Second language on the invoice', 'None');
    expect(screen.queryByText('टैक्स इनवॉइस')).toBeNull();
  });
});
