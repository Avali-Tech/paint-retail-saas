import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withTenant, type DatabaseConnection } from '@paint/db';
import { readCsvTable, toCsv, type CsvError, type CsvTable } from '@paint/shared';
import { sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import type { ImportColumn, Importer, ImportReport, ParsedRow, RowError } from './import-types.js';
import { openingBalancesImporter } from './opening-balances.importer.js';
import { openingStockImporter } from './opening-stock.importer.js';
import { partiesImporter } from './parties.importer.js';
import { productsImporter } from './products.importer.js';

export const MAX_IMPORT_ROWS = 5_000;
const BOM = '\uFEFF';

const IMPORTERS: Record<string, Importer<unknown>> = Object.fromEntries(
  [productsImporter, partiesImporter, openingStockImporter, openingBalancesImporter].map(
    (importer) => [importer.kind, importer as Importer<unknown>],
  ),
);

export interface ImportKind {
  readonly kind: string;
  readonly title: string;
  readonly permission: string;
  readonly columns: readonly ImportColumn[];
}

@Injectable()
export class ImportsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  kinds(): ImportKind[] {
    return Object.values(IMPORTERS).map(({ kind, title, permission, columns }) => ({
      kind,
      title,
      permission,
      columns,
    }));
  }

  /** A CSV with the columns and one example row, with a BOM so Excel reads ₹ and Hindi text. */
  template(auth: AuthContext, kind: string): string {
    const { columns } = this.importer(auth, kind);
    return `${BOM}${toCsv([columns.map((c) => c.name), columns.map((c) => c.example)])}`;
  }

  /** Checks a file and reports what each row would do, saving nothing. */
  preview(auth: AuthContext, kind: string, csv: string): Promise<ImportReport> {
    return this.run(auth, kind, csv, false);
  }

  /** Saves every row in one go, or nothing if any row has a problem. Safe to run again. */
  async commit(auth: AuthContext, kind: string, csv: string): Promise<ImportReport> {
    const report = await this.run(auth, kind, csv, true);
    if (!report.valid) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Nothing was imported: fix the rows with errors and try again',
        report,
      });
    }
    return report;
  }

  // Helpers -----------------------------------------------------------------

  private importer(auth: AuthContext, kind: string): Importer<unknown> {
    const importer = IMPORTERS[kind];
    if (!importer) throw new NotFoundException('Unknown import');
    if (!auth.permissions.has(importer.permission)) {
      throw new ForbiddenException('You do not have permission to import this');
    }
    return importer;
  }

  private async run(
    auth: AuthContext,
    kind: string,
    csv: string,
    commit: boolean,
  ): Promise<ImportReport> {
    const importer = this.importer(auth, kind);
    const errors: RowError[] = [];
    const fail = (row: number, column: string | null, message: string) => {
      errors.push({ row, column, message });
    };
    const finish = (rows: ImportReport['rows'], committed: boolean, rowCount: number) => {
      const count = (action: string) => rows.filter((row) => row.action === action).length;
      errors.sort((a, b) => a.row - b.row || String(a.column).localeCompare(String(b.column)));
      return {
        kind,
        committed,
        valid: errors.length === 0,
        totals: {
          rows: rowCount,
          create: count('create'),
          update: count('update'),
          unchanged: count('unchanged'),
          errors: errors.length,
        },
        rows: [...rows].sort((a, b) => a.row - b.row),
        errors,
      };
    };

    let table: CsvTable;
    try {
      table = readCsvTable(csv);
    } catch (error) {
      // readCsvTable throws only CsvError.
      const { row, message } = error as CsvError;
      fail(row, null, message);
      return finish([], false, 0);
    }
    this.checkColumns(importer, table, fail);
    if (table.rows.length === 0) fail(1, null, 'The file has no rows to import');
    if (table.rows.length > MAX_IMPORT_ROWS) {
      fail(1, null, `Import at most ${MAX_IMPORT_ROWS.toLocaleString('en-IN')} rows at a time`);
    }
    if (errors.length > 0) return finish([], false, table.rows.length);

    const parsed: ParsedRow<unknown>[] = [];
    for (const { row, values } of table.rows) {
      const cells = Object.fromEntries(
        importer.columns.map(({ name }) => [name, values[name] ?? '']),
      );
      const result = importer.row.safeParse(cells);
      if (result.success) {
        parsed.push({ row, value: result.data });
      } else {
        for (const issue of result.error.issues) {
          // Every row check names its column.
          fail(row, String(issue.path[0]), issue.message);
        }
      }
    }

    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      // One import per business at a time, so two cannot add the same record.
      if (commit) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`import:${auth.organization.id}`}, 0))`,
        );
      }
      const plan = await importer.plan(tx, auth, parsed, fail);
      const saving = commit && errors.length === 0;
      if (saving) await plan.apply(tx);
      return finish(plan.rows, saving, table.rows.length);
    });
  }

  private checkColumns(
    importer: Importer<unknown>,
    table: CsvTable,
    fail: (row: number, column: string | null, message: string) => void,
  ): void {
    const known = importer.columns.map((column) => column.name);
    for (const column of table.columns) {
      if (!known.includes(column)) {
        fail(1, column, `Unknown column; use the template's columns: ${known.join(', ')}`);
      }
    }
    for (const column of importer.columns) {
      if (column.required && !table.columns.includes(column.name)) {
        fail(1, column.name, 'This column is missing');
      }
    }
  }
}
