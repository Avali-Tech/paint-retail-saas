import type { ApiClient } from './client.js';

// CSV imports: products, parties and opening stock. Shapes mirror apps/api/src/imports.

export interface ImportColumn {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
  readonly example: string;
}

export interface ImportKind {
  readonly kind: string;
  readonly title: string;
  /** The permission needed to import this kind. */
  readonly permission: string;
  readonly columns: readonly ImportColumn[];
}

export type ImportAction = 'create' | 'update' | 'unchanged';

export interface ImportReport {
  readonly kind: string;
  /** True once the rows have been saved; a preview never saves. */
  readonly committed: boolean;
  readonly valid: boolean;
  readonly totals: {
    readonly rows: number;
    readonly create: number;
    readonly update: number;
    readonly unchanged: number;
    readonly errors: number;
  };
  readonly rows: { readonly row: number; readonly action: ImportAction; readonly label: string }[];
  readonly errors: {
    /** Spreadsheet row; 1 is the header. */
    readonly row: number;
    readonly column: string | null;
    readonly message: string;
  }[];
}

export function importEndpoints(api: ApiClient) {
  return {
    kinds: () => api.get<ImportKind[]>('/imports'),
    preview: (kind: string, csv: string) =>
      api.post<ImportReport>(`/imports/${kind}/preview`, { csv }),
    /** Saves every row, or answers 400 with the report when any row has an error. */
    commit: (kind: string, csv: string) => api.post<ImportReport>(`/imports/${kind}`, { csv }),
  };
}
