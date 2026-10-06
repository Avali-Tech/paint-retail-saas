import { z } from 'zod';

/**
 * What kind of input a report filter takes, so the web app can build it:
 * a store of the member's, an India-time day, one of `values`, a supplier
 * (a party with the supplier role) or yes/no.
 */
export type ReportFilterType = 'store' | 'date' | 'enum' | 'supplier' | 'boolean';

/** GET /reports: one filter a report accepts. */
export interface ReportFilter {
  /** The query parameter, e.g. "storeId". */
  readonly name: string;
  readonly type: ReportFilterType;
  /** The values an enum filter accepts, in display order. */
  readonly values?: readonly string[];
  /** What applies when the filter is left out ("true"/"false" for a boolean). */
  readonly default?: string;
}

interface FilterSpec<S extends z.ZodType> {
  readonly info: Omit<ReportFilter, 'name'>;
  readonly schema: S;
}

/** A store the member works at; left out, all of them. */
export const storeFilter = { info: { type: 'store' }, schema: z.uuid().optional() } as const;
/** An India-time calendar day, YYYY-MM-DD. */
export const dateFilter = { info: { type: 'date' }, schema: z.iso.date().optional() } as const;
export const supplierFilter = { info: { type: 'supplier' }, schema: z.uuid().optional() } as const;

export function enumFilter<const V extends readonly [string, ...string[]]>(values: V) {
  return { info: { type: 'enum', values }, schema: z.enum(values).optional() } as const;
}

/** "true" or "false" in the query; `fallback` when left out. */
export function booleanFilter(fallback: boolean) {
  return {
    info: { type: 'boolean', default: String(fallback) },
    schema: z
      .enum(['true', 'false'])
      .default(fallback ? 'true' : 'false')
      .transform((value) => value === 'true'),
  } as const;
}

/**
 * A report's filters from one description: the schema that parses them and the
 * metadata GET /reports lists, so the two cannot drift apart.
 */
export function reportFilters<T extends Record<string, FilterSpec<z.ZodType>>>(spec: T) {
  const shape = Object.fromEntries(
    Object.entries(spec).map(([name, filter]) => [name, filter.schema]),
  ) as { [K in keyof T]: T[K]['schema'] };
  return {
    filters: z.object(shape),
    filterInfo: Object.entries(spec).map(([name, filter]): ReportFilter => ({
      name,
      ...filter.info,
    })),
  };
}
