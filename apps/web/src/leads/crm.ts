import type { Tone } from '@paint/ui';
import type { QueryClient } from '@tanstack/react-query';
import type { LeadStage, OpportunityStage } from '../api/leads.js';
import type { ProjectStage } from '../api/projects.js';

// Shared by the lead, opportunity and project screens.

export const LEAD_TONE: Record<LeadStage, Tone> = {
  new: 'info',
  contacted: 'primary',
  qualified: 'warning',
  opportunity: 'success',
  won: 'success',
  lost: 'danger',
};

export const OPPORTUNITY_TONE: Record<OpportunityStage, Tone> = {
  discovery: 'info',
  proposal: 'primary',
  negotiation: 'warning',
  won: 'success',
  lost: 'danger',
};

export const PROJECT_TONE: Record<ProjectStage, Tone> = {
  identified: 'info',
  survey: 'info',
  specification: 'primary',
  quotation: 'primary',
  negotiation: 'warning',
  order: 'warning',
  execution: 'warning',
  completed: 'success',
  cancelled: 'danger',
};

/** Everything a lead, opportunity, project or activity change can move, incl. the 360 and dashboard. */
const CRM_QUERIES: ReadonlySet<unknown> = new Set([
  'leads',
  'lead',
  'lead-pipeline',
  'opportunities',
  'opportunity',
  'opportunity-pipeline',
  'projects',
  'project',
  'project-pipeline',
  'activities',
  'party',
  'dashboard',
]);

/** Reloads every CRM screen after a change (only screens on view refetch at once). */
export function refreshCrm(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => CRM_QUERIES.has(query.queryKey[0]),
  });
}

/** "2026-10-02" and "11:00" (India time) -> "2026-10-02T11:00:00+05:30", as the API wants. */
export function indiaMoment(date: string, time: string): string {
  return `${date}T${time}:00+05:30`;
}

/** A form's text, left out when empty (for POST bodies). */
export function given(text: string): string | undefined {
  const value = text.trim();
  return value === '' ? undefined : value;
}
