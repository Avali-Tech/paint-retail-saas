import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withTenant, type DatabaseConnection } from '@paint/db';
import { toCsv } from '@paint/shared';
import { count } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import type { ReportFilter } from './report-filters.js';
import {
  REPORT_KINDS,
  type ReportColumn,
  type ReportKind,
  type ReportRow,
} from './report-kinds.js';

export type { ReportFilter };

/** A column as the API answers it, with an id that stays the same across releases. */
export interface ReportColumnView extends ReportColumn {
  /** "<kind>.<key>", e.g. "transfers.value": the web app translates headers by it. */
  readonly id: string;
}

/** Lets Excel read ₹ and Hindi text in the CSV. */
const BOM = String.fromCharCode(0xfeff);

const paging = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface ReportPage {
  readonly kind: string;
  readonly title: string;
  readonly columns: readonly ReportColumnView[];
  readonly rows: ReportRow[];
  readonly total: number;
}

export interface ReportSummary {
  readonly kind: string;
  readonly title: string;
  readonly columns: readonly ReportColumnView[];
  /** Filters it accepts, with their type and allowed values. */
  readonly filters: readonly ReportFilter[];
}

/** Whether the member may run the report at all. */
const mayRun = (auth: AuthContext, report: ReportKind<unknown>) =>
  auth.permissions.has(report.permission) &&
  (report.needsCosts === undefined || auth.permissions.has('costs:read'));

/** The report's columns the member may see: those at cost only with costs:read. */
const visibleColumns = (auth: AuthContext, report: ReportKind<unknown>) =>
  auth.permissions.has('costs:read')
    ? report.columns
    : report.columns.filter((column) => !report.costColumns?.includes(column.key));

const columnsOf = (auth: AuthContext, report: ReportKind<unknown>): ReportColumnView[] =>
  visibleColumns(auth, report).map((column) => ({ id: `${report.kind}.${column.key}`, ...column }));

/** The row without the columns the member may not see. */
const shownRow = (auth: AuthContext, report: ReportKind<unknown>, row: ReportRow): ReportRow =>
  auth.permissions.has('costs:read')
    ? row
    : Object.fromEntries(Object.entries(row).filter(([key]) => !report.costColumns?.includes(key)));

/** Basic reports with CSV export (roadmap P1-M22). */
@Injectable()
export class ReportsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** The reports the member may run. */
  list(auth: AuthContext): ReportSummary[] {
    return REPORT_KINDS.filter((report) => mayRun(auth, report)).map((report) => ({
      kind: report.kind,
      title: report.title,
      columns: columnsOf(auth, report),
      filters: report.filterInfo,
    }));
  }

  /** One page of a report. */
  page(auth: AuthContext, kind: string, query: Record<string, unknown>): Promise<ReportPage> {
    const report = this.report(auth, kind);
    const filters = parse(report.filters, query);
    const { limit, offset } = parse(paging, query);
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const header = { kind: report.kind, title: report.title, columns: columnsOf(auth, report) };
      if ('rows' in report) {
        const rows = await report.rows(tx, auth, filters);
        return {
          ...header,
          rows: rows.slice(offset, offset + limit).map((row) => shownRow(auth, report, row)),
          total: rows.length,
        };
      }
      const base = report.query(tx, auth, filters);
      const records = (await base.limit(limit).offset(offset)) as Record<string, unknown>[];
      const [totals] = await tx
        .select({ total: count() })
        .from(report.query(tx, auth, filters).as('report'));
      return {
        ...header,
        rows: records.map((record) => shownRow(auth, report, report.toRow(record))),
        total: Number(totals?.total),
      };
    });
  }

  /** The whole report as CSV, with a BOM so Excel reads ₹ and Hindi text. */
  csv(
    auth: AuthContext,
    kind: string,
    query: Record<string, unknown>,
  ): Promise<{ filename: string; body: string }> {
    if (!auth.permissions.has('data:export')) {
      throw new ForbiddenException('You cannot download data');
    }
    const report = this.report(auth, kind);
    const filters = parse(report.filters, query);
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const rows =
        'rows' in report
          ? await report.rows(tx, auth, filters)
          : ((await report.query(tx, auth, filters)) as Record<string, unknown>[]).map((record) =>
              report.toRow(record),
            );
      const columns = visibleColumns(auth, report);
      const body = toCsv([
        columns.map((column) => column.header),
        ...rows.map((row) => columns.map((column) => cell(row[column.key]))),
      ]);
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      return { filename: `${report.kind}-${today}.csv`, body: `${BOM}${body}` };
    });
  }

  private report(auth: AuthContext, kind: string): ReportKind<unknown> {
    const report = REPORT_KINDS.find((candidate) => candidate.kind === kind);
    if (!report) throw new NotFoundException('Unknown report');
    if (!mayRun(auth, report)) {
      throw new ForbiddenException('You do not have permission to see this report');
    }
    return report;
  }
}

function parse<T>(
  schema: z.ZodType<T, Record<string, unknown>>,
  query: Record<string, unknown>,
): T {
  const result = schema.safeParse(query);
  if (result.success) return result.data;
  throw new BadRequestException({
    statusCode: 400,
    message: 'Invalid request',
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}

const cell = (value: string | number | null | undefined) =>
  value === null || value === undefined ? '' : String(value);
