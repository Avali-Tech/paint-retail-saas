import { schema } from '@paint/db';
import { sql, type SQL } from 'drizzle-orm';

const { activities, leads, opportunities, parties, projects } = schema;

/** A short description of the record an activity is about, e.g. "LD-000004 · Kondapur tower". */
export const recordLabel: SQL<string> = sql<string>`case ${activities.recordType}
  when 'lead' then (select ${leads.number} || ' · ' || ${leads.title} from ${leads} where ${leads.id} = ${activities.recordId})
  when 'opportunity' then (select ${opportunities.number} || ' · ' || ${opportunities.title} from ${opportunities} where ${opportunities.id} = ${activities.recordId})
  when 'project' then (select ${projects.number} || ' · ' || ${projects.name} from ${projects} where ${projects.id} = ${activities.recordId})
  else (select ${parties.displayName} from ${parties} where ${parties.id} = ${activities.recordId})
end`;

/** Where each kind of record opens in the web app. */
export const RECORD_PATHS: Record<(typeof schema.activityRecordType.enumValues)[number], string> = {
  party: '/parties/',
  lead: '/leads/',
  opportunity: '/opportunities/',
  project: '/projects/',
};

/** Start of today in India, as a timestamp. */
export const startOfTodayIst = sql`(date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`;
