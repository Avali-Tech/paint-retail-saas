import { describe, expect, it, vi } from 'vitest';
import { fakeFetch, json } from '../test-support/fake-api.js';
import { createApiClient, fileNameFrom } from './client.js';
import { contractEndpoints } from './contracts.js';
import { documentEndpoints } from './documents.js';
import { followUpEndpoints } from './follow-ups.js';
import { reportEndpoints } from './reports.js';

function client(routes: Parameters<typeof fakeFetch>[0]) {
  const api = fakeFetch(routes);
  const onUnauthorized = vi.fn();
  return {
    ...api,
    onUnauthorized,
    api: createApiClient({
      baseUrl: '/api',
      fetch: api.fetch,
      getToken: () => 'tok',
      onUnauthorized,
    }),
  };
}

describe('fileNameFrom', () => {
  it('prefers the UTF-8 name, then the plain one', () => {
    expect(
      fileNameFrom(
        `attachment; filename="_.pdf"; filename*=UTF-8''%E0%A4%AC%E0%A4%BF%E0%A4%B2.pdf`,
      ),
    ).toBe('बिल.pdf');
    expect(fileNameFrom('attachment; filename="leads-2026-10-06.csv"')).toBe(
      'leads-2026-10-06.csv',
    );
    // A broken encoding falls back to the plain name.
    expect(fileNameFrom(`attachment; filename="gst.pdf"; filename*=UTF-8''%E0%A4`)).toBe('gst.pdf');
    expect(fileNameFrom('attachment')).toBeNull();
    expect(fileNameFrom(null)).toBeNull();
  });
});

describe('downloads and uploads', () => {
  it('downloads a file with the bearer token and the server’s name', async () => {
    const { api, requests } = client({
      'GET /documents/d1/download': () => ({
        status: 200,
        raw: 'pdf-bytes',
        headers: { 'content-disposition': 'attachment; filename="gst.pdf"' },
      }),
    });
    const file = await api.download('/documents/d1/download');
    expect(await file.blob.text()).toBe('pdf-bytes');
    expect(file.fileName).toBe('gst.pdf');
    expect(requests[0]?.headers).toEqual({ accept: '*/*', authorization: 'Bearer tok' });
  });

  it('reports a refused download as an ApiError, ending an expired session', async () => {
    const { api, onUnauthorized } = client({
      'GET /documents/d1/download': () => json({ message: 'Unauthorized' }, 401),
    });
    await expect(api.download('/documents/d1/download')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('uploads form data without a JSON content type', async () => {
    const { api, requests } = client({ 'POST /documents': () => json({ id: 'd1' }, 201) });
    const form = new FormData();
    form.set('category', 'other');
    await expect(api.upload('/documents', form)).resolves.toEqual({ id: 'd1' });
    expect(requests[0]?.body).toBe(form);
    expect(requests[0]?.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer tok',
    });
  });
});

describe('follow-up, contract, document and report endpoints', () => {
  it('call the routes the API serves', async () => {
    const ok = () => json({ ok: true });
    const file = () => ({ status: 200, raw: 'x' });
    const { api, requests } = client({
      'GET /activities/follow-ups': ok,
      'GET /activities': ok,
      'PATCH /activities/a1': ok,
      'POST /activities/a1/complete': ok,
      'GET /contracts': ok,
      'GET /contracts/c1': ok,
      'POST /contracts': ok,
      'PATCH /contracts/c1': ok,
      'POST /contracts/c1/activate': ok,
      'POST /contracts/c1/terminate': ok,
      'POST /contracts/c1/renew': ok,
      'GET /documents': ok,
      'POST /documents': ok,
      'GET /documents/d1/download': file,
      'DELETE /documents/d1': () => ({ status: 204 }),
      'GET /reports': ok,
      'GET /reports/leads': (request) =>
        request.query.get('format') === 'csv' ? file() : json({ rows: [] }),
    });
    const followUps = followUpEndpoints(api);
    const contracts = contractEndpoints(api);
    const documents = documentEndpoints(api);
    const reports = reportEndpoints(api);
    const pdf = new File(['%PDF-'], 'gst.pdf');

    await followUps.followUps({ when: 'today', assignedTo: 'm2', limit: 20, offset: 0 });
    await followUps.timeline({ recordType: 'party', recordId: 'p1', limit: 200 });
    await followUps.update('a1', { dueAt: '2026-10-07T11:00:00+05:30' });
    await followUps.complete('a1', { outcome: 'Ordered' });
    await contracts.list({ status: 'active', renewalDue: 30 });
    await contracts.get('c1');
    await contracts.create({
      type: 'other',
      title: 'Terms',
      partyId: 'p1',
      startDate: '2026-10-01',
      endDate: '2027-09-30',
    });
    await contracts.update('c1', { valuePaise: null });
    await contracts.activate('c1');
    await contracts.terminate('c1', 'Stopped work');
    await contracts.renew('c1', { endDate: '2028-09-30' });
    await documents.list('contract', 'c1');
    await documents.upload({
      recordType: 'contract',
      recordId: 'c1',
      category: 'contract',
      note: 'Signed copy',
      file: pdf,
    });
    await documents.upload({ recordType: 'party', recordId: 'p1', category: 'other', file: pdf });
    await documents.download('d1');
    await documents.remove('d1');
    await reports.list();
    await reports.page('leads', { stage: 'new' }, { limit: 50, offset: 50 });
    await reports.csv('leads', { stage: 'new' });

    expect(
      requests.map((request) => `${request.method} ${request.path}?${request.query.toString()}`),
    ).toEqual([
      'GET /activities/follow-ups?when=today&assignedTo=m2&limit=20&offset=0',
      'GET /activities?recordType=party&recordId=p1&limit=200',
      'PATCH /activities/a1?',
      'POST /activities/a1/complete?',
      'GET /contracts?status=active&renewalDue=30',
      'GET /contracts/c1?',
      'POST /contracts?',
      'PATCH /contracts/c1?',
      'POST /contracts/c1/activate?',
      'POST /contracts/c1/terminate?',
      'POST /contracts/c1/renew?',
      'GET /documents?recordType=contract&recordId=c1',
      'POST /documents?',
      'POST /documents?',
      'GET /documents/d1/download?',
      'DELETE /documents/d1?',
      'GET /reports?',
      'GET /reports/leads?stage=new&limit=50&offset=50',
      'GET /reports/leads?stage=new&format=csv',
    ]);
    expect(requests[9]?.body).toEqual({ reason: 'Stopped work' });
    const [withNote, plain] = [requests[12]?.body, requests[13]?.body] as FormData[];
    expect(Object.fromEntries(withNote?.entries() ?? [])).toMatchObject({
      recordType: 'contract',
      recordId: 'c1',
      category: 'contract',
      note: 'Signed copy',
    });
    expect(withNote?.get('file')).toBeInstanceOf(File);
    expect(plain?.has('note')).toBe(false);
  });
});
