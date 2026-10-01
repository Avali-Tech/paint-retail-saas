import type { Transaction } from '@paint/db';
import type { Permission } from '@paint/shared';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';

export type ImportAction = 'create' | 'update' | 'unchanged';

export interface RowError {
  /** Spreadsheet row; 1 is the header. */
  readonly row: number;
  /** The column at fault, or null for the whole row or file. */
  readonly column: string | null;
  readonly message: string;
}

export interface RowPlan {
  readonly row: number;
  readonly action: ImportAction;
  /** What the row is about, such as a SKU or a name. */
  readonly label: string;
}

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
  readonly rows: RowPlan[];
  readonly errors: RowError[];
}

export interface ImportColumn {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
  readonly example: string;
}

export interface ParsedRow<T> {
  readonly row: number;
  readonly value: T;
}

/** Records a problem with a row; rows with problems are never saved. */
export type Fail = (row: number, column: string | null, message: string) => void;

export interface ImportPlan {
  readonly rows: RowPlan[];
  /** Saves every planned row; only called when no row has a problem. */
  apply(tx: Transaction): Promise<void>;
}

export interface Importer<T> {
  readonly kind: string;
  readonly title: string;
  readonly permission: Permission;
  readonly columns: readonly ImportColumn[];
  /** Checks one row's cells, keyed by column name. */
  readonly row: z.ZodType<T, Record<string, string>>;
  /** Checks rows against each other and the database, and works out what each would do. */
  plan(tx: Transaction, auth: AuthContext, rows: ParsedRow<T>[], fail: Fail): Promise<ImportPlan>;
}

/** Rows grouped by a key in first-seen order, used to spot repeats within a file. */
export class FirstSeen<K> {
  private readonly seen = new Map<K, number>();

  /** The row where `key` first appeared, or undefined (and remembers this row). */
  check(key: K, row: number): number | undefined {
    const first = this.seen.get(key);
    if (first === undefined) this.seen.set(key, row);
    return first;
  }
}

export const unique = <T>(values: T[]) => [...new Set(values)];
