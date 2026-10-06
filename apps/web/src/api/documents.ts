import type { Permission } from '@paint/shared';
import type { ApiClient } from './client.js';

// Documents attached to records (roadmap P1-M18). Shapes and rules mirror
// apps/api/src/documents (record-access.ts, file-checks.ts).

/** Records that can carry documents. */
export const DOCUMENT_RECORD_TYPES = [
  'party',
  'product',
  'store',
  'purchase_order',
  'goods_receipt',
  'transfer',
  'stock_count',
  'lead',
  'opportunity',
  'project',
  'contract',
] as const;
export type DocumentRecordType = (typeof DOCUMENT_RECORD_TYPES)[number];

export const DOCUMENT_CATEGORIES = [
  'gst_certificate',
  'pan_card',
  'trade_licence',
  'cancelled_cheque',
  'contract',
  'quotation',
  'invoice',
  'delivery_challan',
  'photo',
  'other',
  'before_photo',
  'after_photo',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

/**
 * Who may see (`read`) and add or remove (`manage`) a record's documents:
 * the record's own permissions, as the API's record-access rules.
 */
export const DOCUMENT_PERMISSIONS: Readonly<
  Record<DocumentRecordType, { readonly read: Permission; readonly manage: Permission }>
> = {
  party: { read: 'parties:read', manage: 'parties:manage' },
  product: { read: 'catalog:read', manage: 'catalog:manage' },
  store: { read: 'stores:read', manage: 'stores:manage' },
  purchase_order: { read: 'purchasing:read', manage: 'purchasing:manage' },
  goods_receipt: { read: 'purchasing:read', manage: 'purchasing:manage' },
  transfer: { read: 'inventory:read', manage: 'inventory:manage' },
  stock_count: { read: 'inventory:read', manage: 'inventory:manage' },
  lead: { read: 'leads:read', manage: 'leads:manage' },
  opportunity: { read: 'leads:read', manage: 'leads:manage' },
  project: { read: 'projects:read', manage: 'projects:manage' },
  contract: { read: 'contracts:read', manage: 'contracts:manage' },
};

/** Where each kind of record opens in the app; stores have no page of their own. */
export const DOCUMENT_RECORD_PATHS: Readonly<Record<DocumentRecordType, string | null>> = {
  party: '/parties/',
  product: '/products/',
  store: null,
  purchase_order: '/purchase-orders/',
  goods_receipt: '/goods-receipts/',
  transfer: '/transfers/',
  stock_count: '/stock-counts/',
  lead: '/leads/',
  opportunity: '/opportunities/',
  project: '/projects/',
  contract: '/contracts/',
};

export interface DocumentFile {
  readonly id: string;
  readonly recordType: DocumentRecordType;
  readonly recordId: string;
  readonly category: DocumentCategory;
  readonly fileName: string;
  readonly contentType: string;
  readonly note: string | null;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly uploadedBy: { readonly memberId: string; readonly name: string };
  readonly createdAt: string;
}

/** A document in the list across records (GET /documents without a record). */
export interface DocumentListItem extends DocumentFile {
  /** How people name the record, e.g. "PO-000012" or "LD-000004 · Kondapur tower". */
  readonly recordLabel: string;
}

export interface DocumentPage {
  readonly items: DocumentListItem[];
  readonly total: number;
}

/** GET /documents without a record: filters and paging. */
export interface DocumentQuery {
  readonly recordType?: DocumentRecordType | undefined;
  readonly category?: DocumentCategory | undefined;
  /** A member id or "me". */
  readonly uploadedBy?: string | undefined;
  /** India-time days of the upload, inclusive (YYYY-MM-DD). */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit?: number;
  readonly offset?: number;
}

export interface DocumentUpload {
  readonly recordType: DocumentRecordType;
  readonly recordId: string;
  readonly category: DocumentCategory;
  readonly note?: string;
  readonly file: File;
}

export function documentEndpoints(api: ApiClient) {
  return {
    list: (recordType: DocumentRecordType, recordId: string, signal?: AbortSignal) =>
      api.get<DocumentFile[]>('/documents', { query: { recordType, recordId }, signal }),
    /** Documents on every record the member can see, newest first. */
    browse: (query: DocumentQuery, signal?: AbortSignal) =>
      api.get<DocumentPage>('/documents', { query: { ...query }, signal }),
    /** Scanned for viruses before it is stored; refused (503) when scanning is down. */
    upload: (upload: DocumentUpload) => {
      const form = new FormData();
      form.set('recordType', upload.recordType);
      form.set('recordId', upload.recordId);
      form.set('category', upload.category);
      if (upload.note !== undefined) form.set('note', upload.note);
      // The file goes last: the API reads the fields before it.
      form.set('file', upload.file, upload.file.name);
      return api.upload<DocumentFile>('/documents', form);
    },
    download: (id: string) => api.download(`/documents/${id}/download`),
    remove: (id: string) => api.delete<undefined>(`/documents/${id}`),
  };
}
