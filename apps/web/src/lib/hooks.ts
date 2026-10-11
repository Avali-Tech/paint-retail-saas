import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

/** `value`, once it has stopped changing for `delay` ms (e.g. a search box). */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettled(value);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [value, delay]);
  return settled;
}

export interface UrlFilters<K extends string> {
  /** Each filter's value, "" when not set. */
  readonly values: Readonly<Record<K, string>>;
  /** Where the list starts (for paging). */
  readonly offset: number;
  /** Where a keyset-paged list's page starts, as the API gave it out (with `offset`). */
  readonly cursor: string | undefined;
  /** Changes one filter and goes back to the first page. */
  readonly set: (key: K, value: string) => void;
  /** Changes several filters at once ("" clears one) and goes back to the first page. */
  readonly setMany: (changes: Partial<Record<K, string>>) => void;
  /** Moves to a page: by `cursor` when the API gave one for it, else by offset alone. */
  readonly setOffset: (offset: number, cursor?: string | null) => void;
}

/**
 * List filters kept in the address (?q=…&role=…&offset=…), so Back, a refresh
 * or a shared link shows the same list.
 */
export function useUrlFilters<K extends string>(keys: readonly K[]): UrlFilters<K> {
  const [params, setParams] = useSearchParams();
  const values = Object.fromEntries(keys.map((key) => [key, params.get(key) ?? ''])) as Record<
    K,
    string
  >;
  const offset = Math.max(0, Number(params.get('offset') ?? 0) || 0);
  const cursor = params.get('cursor') ?? undefined;
  const update = (change: (next: URLSearchParams) => void) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        change(next);
        return next;
      },
      { replace: true },
    );
  };
  // One address change for all of them: several set() calls in one event would each
  // start from the same address and undo one another.
  const setMany = (changes: Partial<Record<K, string>>) => {
    update((next) => {
      for (const [key, value] of Object.entries(changes) as [K, string][]) {
        if (value === '') next.delete(key);
        else next.set(key, value);
      }
      next.delete('offset');
      next.delete('cursor');
    });
  };
  return {
    values,
    offset,
    cursor,
    set: (key, value) => {
      setMany({ [key]: value } as Partial<Record<K, string>>);
    },
    setMany,
    setOffset: (value, nextCursor) => {
      update((next) => {
        if (value === 0) next.delete('offset');
        else next.set('offset', String(value));
        if (value === 0 || !nextCursor) next.delete('cursor');
        else next.set('cursor', nextCursor);
      });
    },
  };
}
