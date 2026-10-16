import type {
  BrandStatementDetail,
  BrandStatementStatus,
  BrandStatementSummaryView,
  ManualMatchInput,
  MatchRunResult,
  SchemeReceiptFromLineInput,
  StatementPreview,
  StatementTemplateInput,
  StatementTemplateView,
} from '@paint/shared';
import type { ApiClient } from '../api/client.js';

// Brand statement reconciliation (apps/api/src/brand-statements, P2-M34). Shapes come
// from @paint/shared.

/** What an upload sends beside the file. */
export interface StatementUpload {
  readonly templateId: string;
  readonly file: File;
  readonly periodFrom?: string;
  readonly periodTo?: string;
  /** Paise, signed like the statement's lines (positive: we owe the brand). */
  readonly openingBalancePaise?: number;
  readonly closingBalancePaise?: number;
}

function formOf(upload: StatementUpload): FormData {
  const form = new FormData();
  form.set('templateId', upload.templateId);
  for (const key of [
    'periodFrom',
    'periodTo',
    'openingBalancePaise',
    'closingBalancePaise',
  ] as const) {
    const value = upload[key];
    if (value !== undefined) form.set(key, String(value));
  }
  form.set('file', upload.file, upload.file.name);
  return form;
}

export function statementEndpoints(api: ApiClient) {
  const line = (id: string, lineId: string, action: string) =>
    `/brand-statements/${id}/lines/${lineId}/${action}`;
  return {
    templates: (signal?: AbortSignal) =>
      api.get<StatementTemplateView[]>('/brand-statements/templates', { signal }),
    createTemplate: (body: StatementTemplateInput) =>
      api.post<StatementTemplateView>('/brand-statements/templates', body),
    updateTemplate: (id: string, body: StatementTemplateInput) =>
      api.put<StatementTemplateView>(`/brand-statements/templates/${id}`, body),
    preview: (upload: StatementUpload) =>
      api.upload<StatementPreview>('/brand-statements/preview', formOf(upload)),
    import: (upload: StatementUpload) =>
      api.upload<BrandStatementDetail>('/brand-statements', formOf(upload)),
    list: (status: BrandStatementStatus, signal?: AbortSignal) =>
      api.get<BrandStatementSummaryView[]>('/brand-statements', { query: { status }, signal }),
    detail: (id: string, signal?: AbortSignal) =>
      api.get<BrandStatementDetail>(`/brand-statements/${id}`, { signal }),
    rematch: (id: string) => api.post<MatchRunResult>(`/brand-statements/${id}/match`),
    discard: (id: string) => api.post<BrandStatementSummaryView>(`/brand-statements/${id}/discard`),
    match: (id: string, lineId: string, body: ManualMatchInput) =>
      api.post<BrandStatementDetail>(line(id, lineId, 'match'), body),
    unmatch: (id: string, lineId: string) =>
      api.delete<BrandStatementDetail>(line(id, lineId, 'match')),
    explain: (id: string, lineId: string, note: string) =>
      api.post<BrandStatementDetail>(line(id, lineId, 'explain'), { note }),
    schemeReceipt: (id: string, lineId: string, body: SchemeReceiptFromLineInput) =>
      api.post<BrandStatementDetail>(line(id, lineId, 'scheme-receipt'), body),
    /** The mismatch list as CSV. */
    csv: (id: string) => api.download(`/brand-statements/${id}/mismatches.csv`),
    /** The original file, when it was kept. */
    file: (id: string) => api.download(`/brand-statements/${id}/file`),
  };
}
