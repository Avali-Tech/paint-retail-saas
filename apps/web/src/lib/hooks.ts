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
  /** Changes one filter and goes back to the first page. */
  readonly set: (key: K, value: string) => void;
  readonly setOffset: (offset: number) => void;
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
  return {
    values,
    offset,
    set: (key, value) => {
      update((next) => {
        if (value === '') next.delete(key);
        else next.set(key, value);
        next.delete('offset');
      });
    },
    setOffset: (value) => {
      update((next) => {
        if (value === 0) next.delete('offset');
        else next.set('offset', String(value));
      });
    },
  };
}
