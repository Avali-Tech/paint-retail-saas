import { SCHEME_STATUSES, type SlabMeasure } from '@paint/shared';
import { dateFilter, enumFilter, reportFilters } from '../reports/report-filters.js';
import type { ComputedReportKind, ReportRow } from '../reports/report-kinds.js';
import { rupees } from '../reports/report-values.js';
import { claimsReport, schemeSummaries } from './brand-schemes.service.js';

// Brand schemes as CSV through the reports framework (P2-M33): the same engines and
// figures as GET /brand-schemes and GET /brand-schemes/claims, every row at once.

/** A figure in the scheme's measure: rupees for a value scheme, litres for a litres one. */
const inMeasure = (measure: SlabMeasure, amount: number | null) =>
  amount === null ? null : measure === 'value' ? rupees(amount) : amount / 1000;

interface ProgressFilters {
  asOf?: string;
  schemeStatus?: (typeof SCHEME_STATUSES)[number];
}

/** One row per scheme: where it stands against its slabs and what it has earned. */
export const brandSchemesReport: ComputedReportKind<ProgressFilters> = {
  kind: 'brand-schemes',
  title: 'Brand schemes',
  permission: 'purchasing:read',
  columns: [
    { key: 'brand', header: 'Brand' },
    { key: 'scheme', header: 'Scheme' },
    { key: 'startsOn', header: 'From' },
    { key: 'endsOn', header: 'To' },
    { key: 'status', header: 'Status' },
    { key: 'measure', header: 'Target in' },
    { key: 'mode', header: 'Slabs pay' },
    { key: 'achieved', header: 'Achieved (₹ or L)' },
    { key: 'freeLitres', header: 'Of which free (L)' },
    { key: 'currentSlab', header: 'Slab reached' },
    { key: 'nextTarget', header: 'Next slab (₹ or L)' },
    { key: 'toGo', header: 'To the next slab (₹ or L)' },
    { key: 'perDay', header: 'Needed per day (₹ or L)' },
    { key: 'daysLeft', header: 'Days left' },
    { key: 'projected', header: 'Projected (₹ or L)' },
    { key: 'expected', header: 'Credit earned (₹)' },
    { key: 'received', header: 'Received (₹)' },
    { key: 'outstanding', header: 'Still owed (₹)' },
  ],
  ...reportFilters({ asOf: dateFilter, schemeStatus: enumFilter(SCHEME_STATUSES) }),
  async rows(tx, _auth, filters): Promise<ReportRow[]> {
    const summaries = await schemeSummaries(tx, {
      asOf: filters.asOf,
      status: filters.schemeStatus,
    });
    return summaries.map(({ scheme, progress, claim }) => ({
      brand: scheme.brand.name,
      scheme: scheme.name,
      startsOn: scheme.startsOn,
      endsOn: scheme.endsOn,
      status: scheme.status,
      measure: scheme.measure,
      mode: scheme.mode,
      achieved: inMeasure(scheme.measure, progress.achieved),
      freeLitres: progress.freeMillilitres / 1000,
      currentSlab: progress.current === null ? null : progress.current.index + 1,
      nextTarget: inMeasure(scheme.measure, progress.next?.target ?? null),
      toGo: inMeasure(scheme.measure, progress.next?.distance ?? null),
      perDay: inMeasure(scheme.measure, progress.next?.perDayNeeded ?? null),
      daysLeft: progress.remainingDays,
      projected: inMeasure(scheme.measure, progress.projected),
      expected: rupees(claim.money.expectedPaise),
      received: rupees(claim.money.receivedPaise),
      outstanding: rupees(claim.money.outstandingPaise),
    }));
  },
};

/** One row per active or closed scheme: expected vs received and how late it is. */
export const brandSchemeClaimsReport: ComputedReportKind<{ asOf?: string }> = {
  kind: 'brand-scheme-claims',
  title: 'Brand scheme claims',
  permission: 'purchasing:read',
  columns: [
    { key: 'brand', header: 'Brand' },
    { key: 'scheme', header: 'Scheme' },
    { key: 'status', header: 'Scheme status' },
    { key: 'endsOn', header: 'Period ended' },
    { key: 'dueOn', header: 'Due' },
    { key: 'daysPastDue', header: 'Days past due' },
    { key: 'bucket', header: 'Age' },
    { key: 'claimStatus', header: 'Claim' },
    { key: 'expected', header: 'Expected (₹)' },
    { key: 'received', header: 'Received (₹)' },
    { key: 'outstanding', header: 'Outstanding (₹)' },
    { key: 'freeUnitsOwed', header: 'Free units owed' },
    { key: 'pointsOwed', header: 'Points owed' },
    { key: 'filed', header: 'Filed claim' },
    { key: 'filedStatus', header: 'Filed claim status' },
  ],
  ...reportFilters({ asOf: dateFilter }),
  async rows(tx, _auth, filters): Promise<ReportRow[]> {
    const report = await claimsReport(tx, { asOf: filters.asOf });
    const owed = (amounts: readonly number[]) =>
      amounts.reduce((sum, amount) => sum + Math.max(amount, 0), 0);
    return report.rows.map(({ scheme, claim, filed }) => ({
      brand: scheme.brand.name,
      scheme: scheme.name,
      status: scheme.status,
      endsOn: scheme.endsOn,
      dueOn: claim.dueOn,
      daysPastDue: claim.daysPastDue,
      bucket: claim.bucket,
      claimStatus: claim.status,
      expected: rupees(claim.money.expectedPaise),
      received: rupees(claim.money.receivedPaise),
      outstanding: rupees(claim.money.outstandingPaise),
      freeUnitsOwed: owed(claim.freeGoods.map((row) => row.outstandingUnits)),
      pointsOwed: owed(claim.points.map((row) => row.outstanding)),
      filed: filed?.number ?? null,
      filedStatus: filed?.status ?? null,
    }));
  },
};
