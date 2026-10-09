import pg from 'pg';

/**
 * Gives the demo a past. The API stamps everything with the database's now(),
 * so the seed does each simulated day's work for real, notes the stretch of
 * real time it took, and afterwards moves every timestamp written in that
 * stretch onto the simulated day (10:00 to 19:00 India time), keeping the
 * order of events. This is the one place the seed writes to the database
 * directly: the API has no way to back-date, by design.
 */
export interface HistoryWindow {
  /** Real time the day's work started and ended (database clock). */
  readonly realStart: Date;
  readonly realEnd: Date;
  /** Days before today (India time) the work is moved to; 1 = yesterday. */
  readonly daysAgo: number;
}

/** Columns that hold deadlines or expiries chosen on purpose, not when something happened. */
export const UNSHIFTED_COLUMNS: ReadonlySet<string> = new Set([
  'due_at',
  'expires_at',
  'next_attempt_at',
]);

/**
 * Business dates the API takes from the database's today (an invoice's issue
 * date, a payment's receipt date…), by table, with the timestamp telling when
 * the row was written: each moves by as many days as that timestamp does.
 * Dates the seed chose itself (the go-live date and the opening balances
 * dated on it, overdue-since dates, contract ends) stay put.
 */
export const SHIFTED_DATES: readonly {
  readonly table: string;
  readonly writtenAt: string;
  readonly columns: readonly string[];
  /** Rows to leave alone, as a condition on the table `t`. */
  readonly except?: string;
}[] = [
  { table: 'tax_documents', writtenAt: 'created_at', columns: ['issued_on', 'due_on'] },
  {
    table: 'party_ledger',
    writtenAt: 'created_at',
    columns: ['entry_on'],
    except: "t.entry_type = 'opening'",
  },
  {
    table: 'payments',
    writtenAt: 'created_at',
    columns: ['received_on', 'cheque_date', 'cheque_cleared_on', 'cheque_bounced_on'],
  },
  { table: 'quotations', writtenAt: 'created_at', columns: ['valid_until', 'priced_on'] },
  { table: 'sales_orders', writtenAt: 'created_at', columns: ['priced_on'] },
];

/** Business hours of a simulated day, in India time. */
const DAY_OPENS = '10:00';
const DAY_HOURS = 9;

/** The India date `daysAgo` days before `now`, as YYYY-MM-DD. */
export function indiaDate(daysAgo: number, now: Date = new Date()): string {
  return new Date(now.getTime() - daysAgo * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Kolkata',
  });
}

/** When a simulated day opens: 10:00 India time, `daysAgo` days before `now`. */
export function dayOpensAt(daysAgo: number, now: Date = new Date()): Date {
  return new Date(`${indiaDate(daysAgo, now)}T${DAY_OPENS}:00+05:30`);
}

export class HistoryClock {
  readonly windows: HistoryWindow[] = [];
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  }

  /** Runs one simulated day's work and remembers when it happened. */
  async day<T>(daysAgo: number, work: () => Promise<T>): Promise<T> {
    const realStart = await this.now();
    const result = await work();
    this.windows.push({ realStart, realEnd: await this.now(), daysAgo });
    return result;
  }

  /**
   * Moves every timestamp written during a recorded day onto that day, in
   * every table, with triggers off for the change (the stock and points
   * ledgers and the audit log refuse edits otherwise). Loyalty expiry dates
   * move with the entries they belong to. Needs a superuser, as the local
   * PostgreSQL and the test databases have.
   */
  async apply(now: Date = new Date()): Promise<number> {
    if (this.windows.length === 0) return 0;
    const values = this.windows
      .map((window, index) => {
        const start = 4 * index;
        return `($${String(start + 1)}::timestamptz, $${String(start + 2)}::timestamptz, $${String(start + 3)}::timestamptz, $${String(start + 4)}::float8)`;
      })
      .join(', ');
    const parameters = this.windows.flatMap((window) => {
      const realSeconds = Math.max(
        (window.realEnd.getTime() - window.realStart.getTime()) / 1000,
        0.001,
      );
      return [
        window.realStart.toISOString(),
        window.realEnd.toISOString(),
        dayOpensAt(window.daysAgo, now).toISOString(),
        (DAY_HOURS * 3600) / realSeconds,
      ];
    });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query(
        `CREATE TEMPORARY TABLE demo_windows (real_start timestamptz, real_end timestamptz, sim_start timestamptz, speed float8) ON COMMIT DROP`,
      );
      await client.query(`INSERT INTO demo_windows VALUES ${values}`, parameters);
      const columns = await client.query<{ table_name: string; column_name: string }>(
        `SELECT c.table_name, c.column_name
           FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
            AND c.data_type = 'timestamp with time zone'
          ORDER BY c.table_name, c.column_name`,
      );
      let moved = 0;
      // Dates first, while each row's timestamp still says when it was really written.
      for (const { table, writtenAt, columns: dates, except = 'false' } of SHIFTED_DATES) {
        const days = `((w.sim_start AT TIME ZONE 'Asia/Kolkata')::date - (t."${writtenAt}" AT TIME ZONE 'Asia/Kolkata')::date)`;
        const result = await client.query(
          `UPDATE "${table}" t SET ${dates.map((date) => `"${date}" = t."${date}" + ${days}`).join(', ')}
             FROM demo_windows w
            WHERE t."${writtenAt}" BETWEEN w.real_start AND w.real_end AND NOT (${except})`,
        );
        moved += Number(result.rowCount);
      }
      for (const { table_name: table, column_name: column } of columns.rows) {
        if (UNSHIFTED_COLUMNS.has(column)) continue;
        const shifted = `w.sim_start + (t."${column}" - w.real_start) * w.speed`;
        const expiry =
          table === 'loyalty_ledger' && column === 'created_at'
            ? `, expires_on = t.expires_on + (((${shifted}) AT TIME ZONE 'Asia/Kolkata')::date - (t."${column}" AT TIME ZONE 'Asia/Kolkata')::date)`
            : '';
        const result = await client.query(
          `UPDATE "${table}" t SET "${column}" = ${shifted}${expiry}
             FROM demo_windows w
            WHERE t."${column}" BETWEEN w.real_start AND w.real_end`,
        );
        moved += Number(result.rowCount);
      }
      await client.query('COMMIT');
      return moved;
    } finally {
      // Never reused: if anything failed, closing the connection rolls the change back.
      client.release(true);
    }
  }

  /** The India date `daysAhead` days from today, by the database clock (as the API dates things). */
  async today(daysAhead = 0): Promise<string> {
    const result = await this.pool.query<{ day: string }>(
      "SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date + $1::int)::text AS day",
      [daysAhead],
    );
    return (result.rows[0] as { day: string }).day;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async now(): Promise<Date> {
    const result = await this.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    return (result.rows[0] as { now: Date }).now;
  }
}
