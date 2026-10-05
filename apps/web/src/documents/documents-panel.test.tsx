import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CASHIER, OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { DOCUMENT, FILE_HEADS, fileOf } from '../test-support/document-fixtures.js';
import { PARTY } from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { DocumentsPanel } from './DocumentsPanel.js';

const NO_HEADERS: Record<string, string> = {};

const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:document');
const click = vi.fn<(this: HTMLAnchorElement) => void>();

beforeEach(() => {
  Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(
    this: HTMLAnchorElement,
  ) {
    click.call(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  createObjectURL.mockClear();
  click.mockClear();
});

function renderPanel(
  routes: Record<string, FakeHandler>,
  me = OWNER,
  recordType: 'party' | 'contract' = 'party',
) {
  return renderApp({
    element: <DocumentsPanel recordType={recordType} recordId={PARTY.id} />,
    routes: { 'GET /auth/me': () => json(me), ...routes },
  });
}

const panel = () => screen.getByRole('region', { name: 'Documents' });

describe('DocumentsPanel', { timeout: 30_000 }, () => {
  it('lists a record’s documents and downloads them under the server’s name', async () => {
    let answer: 'named' | 'unnamed' | 'gone' = 'named';
    const { user, requests } = renderPanel({
      'GET /documents': () => json([{ ...DOCUMENT, note: 'Renewed in 2026' }]),
      'GET /documents/:id/download': () =>
        answer === 'gone'
          ? json({ message: 'Document not found' }, 404)
          : {
              status: 200,
              raw: '%PDF-1.7',
              headers:
                answer === 'named'
                  ? { 'content-disposition': `attachment; filename="gst-certificate.pdf"` }
                  : NO_HEADERS,
            },
    });
    expect(
      await within(await screen.findByRole('region', { name: 'Documents' })).findByText('gst.pdf'),
    ).toBeVisible();
    expect(requests.find((request) => request.path === '/documents')?.query.toString()).toBe(
      `recordType=party&recordId=${PARTY.id}`,
    );
    expect(within(panel()).getByText('1')).toBeVisible();
    expect(within(panel()).getByText('Renewed in 2026')).toBeVisible();

    await user.click(within(panel()).getByRole('button', { name: 'Download gst.pdf' }));
    await waitFor(() => {
      expect(click).toHaveBeenCalledOnce();
    });
    expect(click.mock.contexts[0]?.download).toBe('gst-certificate.pdf');
    expect(await createObjectURL.mock.calls[0]?.[0].text()).toBe('%PDF-1.7');
    expect(
      requests.find((request) => request.path.endsWith('/download'))?.headers.authorization,
    ).toBe('Bearer session-token');

    answer = 'unnamed';
    await user.click(within(panel()).getByRole('button', { name: 'Download gst.pdf' }));
    await waitFor(() => {
      expect(click).toHaveBeenCalledTimes(2);
    });
    expect(click.mock.contexts[1]?.download).toBe('gst.pdf');

    answer = 'gone';
    await user.click(within(panel()).getByRole('button', { name: 'Download gst.pdf' }));
    expect(await screen.findByText('Could not download the file')).toBeVisible();
    expect(screen.getByText('Document not found')).toBeVisible();
  });

  it('checks a file before uploading and says why the server refused it', async () => {
    let answer: 'scanner' | 'storage' | 'type' | 'big' | 'virus' | 'down' | 'ok' = 'scanner';
    let listed = [DOCUMENT];
    const { user, requests } = renderPanel({
      'GET /documents': () => json(listed),
      'POST /documents': () => {
        switch (answer) {
          case 'scanner':
            return json(
              { message: 'Virus scanning is unavailable, so the file was not saved' },
              503,
            );
          case 'storage':
            return json({ message: 'Document storage is not set up on this server' }, 503);
          case 'type':
            return json({ message: 'Upload a PDF, a photo or a Word or Excel file' }, 415);
          case 'big':
            return json({ message: 'Files can be at most 10 MB' }, 413);
          case 'virus':
            return json(
              { message: 'This file contains a virus (Eicar-Signature) and was not saved' },
              422,
            );
          case 'down':
            return json({ message: 'Database down' }, 500);
          default:
            listed = [
              { ...DOCUMENT, id: 'new', fileName: 'quote.pdf', category: 'quotation' },
              DOCUMENT,
            ];
            return json(listed[0], 201);
        }
      },
    });
    await user.click(
      await within(await screen.findByRole('region', { name: 'Documents' })).findByRole('button', {
        name: 'Upload',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Upload a document' });
    const send = () => user.click(within(dialog).getByRole('button', { name: 'Upload' }));
    const input = within(dialog).getByLabelText(/^File/);

    await send();
    expect(await within(dialog).findByText('Choose a file to upload')).toBeVisible();

    fireEvent.change(input, { target: { files: [fileOf('notes.txt', FILE_HEADS.text)] } });
    await send();
    expect(await within(dialog).findByText(/This kind of file is not accepted/)).toBeVisible();

    fireEvent.change(input, { target: { files: [fileOf('empty.pdf', [])] } });
    await send();
    expect(await within(dialog).findByText('This file is empty')).toBeVisible();

    fireEvent.change(input, { target: { files: [] } });
    await send();
    expect(await within(dialog).findByText('Choose a file to upload')).toBeVisible();

    await user.upload(input, fileOf('quote.pdf', FILE_HEADS.pdf, 'application/pdf'));
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'What it is' }),
      'Quotation',
    );
    await user.type(within(dialog).getByRole('textbox', { name: 'Note' }), ' For the villa ');
    await send();
    expect(
      await within(dialog).findByText(/The virus scanner is off or not working/),
    ).toBeVisible();
    const sent = requests.findLast((request) => request.method === 'POST')?.body as FormData;
    expect(sent.get('category')).toBe('quotation');
    expect(sent.get('note')).toBe('For the villa');
    expect(sent.get('recordType')).toBe('party');
    expect((sent.get('file') as File).name).toBe('quote.pdf');

    answer = 'storage';
    await send();
    expect(await within(dialog).findByText(/Document storage is not set up/)).toBeVisible();
    answer = 'type';
    await send();
    expect(await within(dialog).findByText(/This kind of file is not accepted/)).toBeVisible();
    answer = 'big';
    await send();
    expect(await within(dialog).findByText(/larger than 10 MB/)).toBeVisible();
    answer = 'virus';
    await send();
    expect(
      await within(dialog).findByText(
        'The file was refused: This file contains a virus (Eicar-Signature) and was not saved',
      ),
    ).toBeVisible();
    answer = 'down';
    await send();
    expect(await within(dialog).findByText('Database down')).toBeVisible();

    answer = 'ok';
    await user.clear(within(dialog).getByRole('textbox', { name: 'Note' }));
    await send();
    expect(await screen.findByText('Document uploaded')).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await within(panel()).findByText('quote.pdf')).toBeVisible();
    const plain = requests.findLast((request) => request.method === 'POST')?.body as FormData;
    expect(plain.has('note')).toBe(false);
  });

  it('deletes a document after asking', async () => {
    let listed = [DOCUMENT];
    const { user, requests } = renderPanel({
      'GET /documents': () => json(listed),
      'DELETE /documents/:id': () => {
        listed = [];
        return { status: 204 };
      },
    });
    await user.click(
      await within(await screen.findByRole('region', { name: 'Documents' })).findByRole('button', {
        name: 'Delete gst.pdf',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete gst.pdf?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(within(panel()).getByRole('button', { name: 'Delete gst.pdf' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Document deleted')).toBeVisible();
    expect(await within(panel()).findByText('No documents yet')).toBeVisible();
    expect(
      requests.some(
        (request) => request.method === 'DELETE' && request.path === `/documents/${DOCUMENT.id}`,
      ),
    ).toBe(true);
  });

  it('lets read-only roles download but not change, and hides records they cannot see', async () => {
    renderPanel({ 'GET /documents': () => json([DOCUMENT]) }, CASHIER);
    expect(
      await within(await screen.findByRole('region', { name: 'Documents' })).findByRole('button', {
        name: 'Download gst.pdf',
      }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete gst.pdf' })).toBeNull();
  });

  it('shows nothing on a record the role cannot see, and a failure to load', async () => {
    const hidden = renderPanel({ 'GET /documents': () => json([DOCUMENT]) }, CASHIER, 'contract');
    await waitFor(() => {
      expect(hidden.requests.some((request) => request.path === '/auth/me')).toBe(true);
    });
    expect(screen.queryByRole('region', { name: 'Documents' })).toBeNull();
    expect(hidden.requests.some((request) => request.path === '/documents')).toBe(false);
    hidden.unmount();

    renderPanel({ 'GET /documents': () => json({ message: 'Database down' }, 503) });
    expect(await screen.findByText('Could not load the documents')).toBeVisible();
  });
});
