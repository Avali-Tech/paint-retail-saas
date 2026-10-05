import type { ReportSummary } from '../api/reports.js';
import { en } from '../i18n/en.js';
import { humanize, stageLabel, type I18n } from '../i18n/i18n.js';

// The choices each report filter offers. The API lists a report's filter names
// (GET /reports); the values mirror its enums in packages/db/src/schema.ts.

const MOVEMENT_TYPES = [
  'opening',
  'purchase_receipt',
  'purchase_return',
  'transfer_in',
  'transfer_out',
  'sale',
  'sale_return',
  'adjustment',
  'damage',
  'count_correction',
] as const;
const TRANSFER_STATUSES = [
  'requested',
  'approved',
  'in_transit',
  'received',
  'rejected',
  'cancelled',
] as const;
const LEAD_STAGES = ['new', 'contacted', 'qualified', 'opportunity', 'won', 'lost'] as const;
const PROJECT_STAGES = [
  'identified',
  'survey',
  'specification',
  'quotation',
  'negotiation',
  'order',
  'execution',
  'completed',
  'cancelled',
] as const;
const LEAD_SOURCES = [
  'walk_in',
  'phone_call',
  'referral',
  'architect',
  'contractor',
  'painter',
  'website',
  'social_media',
  'exhibition',
  'other',
] as const;

export interface Choice {
  readonly value: string;
  readonly label: string;
}

/** The values a choice filter offers on a report, or null when it is not a choice. */
export function filterChoices(i18n: I18n, kind: string, filter: string): Choice[] | null {
  const { t, label } = i18n;
  const stages = kind === 'projects' ? PROJECT_STAGES : LEAD_STAGES;
  switch (filter) {
    case 'movementType':
      return MOVEMENT_TYPES.map((value) => ({
        value,
        label: label('reportMovementTypes', value),
      }));
    case 'status':
      return TRANSFER_STATUSES.map((value) => ({ value, label: label('transferStatus', value) }));
    case 'stage':
      return stages.map((value) => ({ value, label: stageLabel(t, value) }));
    case 'source':
      return LEAD_SOURCES.map((value) => ({ value, label: label('reportLeadSources', value) }));
    default:
      return null;
  }
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
