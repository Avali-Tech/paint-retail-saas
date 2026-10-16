import type { ReportColumn, ReportFilter, ReportSummary } from '../api/reports.js';
import { en } from '../i18n/en.js';
import { humanize, stageLabel, type I18n } from '../i18n/i18n.js';

// Report filters and columns as GET /reports describes them: each filter's
// type and allowed values come from the API, so no enum is copied here; the
// app only names them in the member's language.

export interface Choice {
  readonly value: string;
  readonly label: string;
}

/** An enum filter's value in the member's language; unknown filters and values are humanized. */
function choiceLabel(i18n: I18n, filter: string, value: string): string {
  const { t, label } = i18n;
  switch (filter) {
    case 'movementType':
      return label('reportMovementTypes', value);
    case 'status':
      return label('transferStatus', value);
    case 'stage':
      return stageLabel(t, value);
    case 'source':
      return label('reportLeadSources', value);
    case 'groupBy':
      return label('ageingGroups', value);
    case 'schemeStatus':
      return label('schemeStatus', value);
    default:
      return humanize(value);
  }
}

/** The values an enum filter offers, named; empty for other filters. */
export function filterChoices(i18n: I18n, filter: ReportFilter): Choice[] {
  return (filter.values ?? []).map((value) => ({
    value,
    label: choiceLabel(i18n, filter.name, value),
  }));
}

type FilterName = keyof typeof en.reports.filters;

/** A filter's name, e.g. "storeId" -> "Store"; unknown ones are humanized. */
export function filterLabel(t: I18n['t'], filter: string): string {
  return filter in en.reports.filters
    ? t(`reports.filters.${filter as FilterName}`)
    : humanize(filter);
}

type KindKey = keyof typeof en.reports.kinds;

/** A report's title and description in the member's language; the API's title for new kinds. */
export function reportText(
  t: I18n['t'],
  report: Pick<ReportSummary, 'kind' | 'title'>,
): { title: string; description: string | null } {
  if (!(report.kind in en.reports.kinds)) return { title: report.title, description: null };
  const kind = report.kind as KindKey;
  return {
    title: t(`reports.kinds.${kind}.title`),
    description: t(`reports.kinds.${kind}.description`),
  };
}

type Columns = Readonly<Record<string, Readonly<Record<string, string>>>>;
const COLUMNS: Columns = en.reports.columns;

/**
 * A column's header in the member's language, found by the column's stable id
 * ("<kind>.<key>"); the API's English header for columns the app does not know.
 */
export function columnHeader(t: I18n['t'], column: ReportColumn): string {
  const split = column.id.indexOf('.');
  const kind = column.id.slice(0, split);
  const key = column.id.slice(split + 1);
  if (split < 0 || COLUMNS[kind]?.[key] === undefined) return column.header;
  return t(`reports.columns.${kind}.${key}` as Parameters<I18n['t']>[0]);
}
