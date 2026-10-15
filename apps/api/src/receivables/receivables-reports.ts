import { AGEING_GROUPS, RECEIVABLES_PERMISSION, type AgeingTotals } from '@paint/shared';
import { indiaToday } from '../billing/invoice-view.js';
import { dateFilter, enumFilter, reportFilters, storeFilter } from '../reports/report-filters.js';
import type { ComputedReportKind, ReportRow } from '../reports/report-kinds.js';
import { rupees } from '../reports/report-values.js';
import { ageingRows, partyOf, storeOf } from './ageing-rows.js';
import { ageBooks, ageingLookups } from './receivables.service.js';

// Receivables ageing as CSV, through the reports framework (roadmap P2-M10): the same
// engine and figures as GET /receivables/ageing, every row at once.

const bucketColumns = [
  { key: 'notDue', header: 'Not yet due (₹)' },
  { key: 'days0To30', header: '0–30 days (₹)' },
  { key: 'days31To60', header: '31–60 days (₹)' },
  { key: 'days61To90', header: '61–90 days (₹)' },
  { key: 'days90Plus', header: 'Over 90 days (₹)' },
] as const;

const bucketCells = (totals: AgeingTotals) => ({
  notDue: rupees(totals.buckets.not_due),
  days0To30: rupees(totals.buckets.days_0_30),
  days31To60: rupees(totals.buckets.days_31_60),
  days61To90: rupees(totals.buckets.days_61_90),
  days90Plus: rupees(totals.buckets.days_90_plus),
});

interface AgeingFilters {
  asOf?: string;
  storeId?: string;
  groupBy?: (typeof AGEING_GROUPS)[number];
}

/** One row per customer, salesperson or store, with its outstanding by age. */
export const receivablesAgeing: ComputedReportKind<AgeingFilters> = {
  kind: 'receivables-ageing',
  title: 'Receivables ageing',
  permission: RECEIVABLES_PERMISSION,
  columns: [
    { key: 'name', header: 'Name' },
    { key: 'code', header: 'Store code' },
    { key: 'phone', header: 'Mobile' },
    { key: 'customers', header: 'Customers' },
    ...bucketColumns,
    { key: 'outstanding', header: 'Total outstanding (₹)' },
    { key: 'advance', header: 'Paid in advance (₹)' },
    { key: 'net', header: 'Balance (₹)' },
    { key: 'maxDaysPastDue', header: 'Most days late' },
    { key: 'limit', header: 'Credit limit (₹)' },
  ],
  ...reportFilters({ asOf: dateFilter, storeId: storeFilter, groupBy: enumFilter(AGEING_GROUPS) }),
  async rows(tx, auth, filters): Promise<ReportRow[]> {
    const asOf = filters.asOf ?? (await indiaToday(tx));
    const result = await ageBooks(tx, auth, { asOf, storeId: filters.storeId });
    const rows = ageingRows(
      result,
      filters.groupBy ?? 'customer',
      await ageingLookups(tx, auth, result),
    );
    return rows.map((row) => ({
      name: row.name,
      code: row.code,
      phone: row.phone,
      customers: row.customers,
      ...bucketCells(row.totals),
      outstanding: rupees(row.totals.outstandingPaise),
      advance: rupees(row.totals.unappliedPaise),
      net: rupees(row.totals.netPaise),
      maxDaysPastDue: row.maxDaysPastDue,
      limit: rupees(row.limitPaise),
    }));
  },
};

/** One row per bill with money due, most overdue first: what to collect. */
export const receivablesOpenBills: ComputedReportKind<Omit<AgeingFilters, 'groupBy'>> = {
  kind: 'receivables-open-bills',
  title: 'Open bills by age',
  permission: RECEIVABLES_PERMISSION,
  columns: [
    { key: 'customer', header: 'Customer' },
    { key: 'phone', header: 'Mobile' },
    { key: 'salesperson', header: 'Salesperson' },
    { key: 'store', header: 'Store' },
    { key: 'kind', header: 'Kind' },
    { key: 'number', header: 'Number' },
    { key: 'raisedOn', header: 'Date' },
    { key: 'dueOn', header: 'Due on' },
    { key: 'daysPastDue', header: 'Days late' },
    { key: 'bucket', header: 'Age' },
    { key: 'total', header: 'Bill total (₹)' },
    { key: 'outstanding', header: 'Outstanding (₹)' },
  ],
  ...reportFilters({ asOf: dateFilter, storeId: storeFilter }),
  async rows(tx, auth, filters): Promise<ReportRow[]> {
    const asOf = filters.asOf ?? (await indiaToday(tx));
    const result = await ageBooks(tx, auth, { asOf, storeId: filters.storeId });
    const lookups = await ageingLookups(tx, auth, result);
    return result.receivables.map((bill) => {
      const party = partyOf(lookups, bill.partyId);
      return {
        customer: party.name,
        phone: party.phone,
        salesperson: party.salespersonName,
        store: storeOf(lookups, bill.storeId)?.code ?? null,
        kind: bill.kind,
        number: bill.number,
        raisedOn: bill.raisedOn,
        dueOn: bill.effectiveDueOn,
        daysPastDue: Math.max(bill.daysPastDue, 0),
        bucket: bill.bucket,
        total: rupees(bill.totalPaise),
        outstanding: rupees(bill.outstandingPaise),
      };
    });
  },
};
