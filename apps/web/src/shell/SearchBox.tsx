import type { QuickAction } from '@paint/shared';
import { Icon, Spinner } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useId, useState, type KeyboardEvent, type RefObject } from 'react';
import { useNavigate } from 'react-router';
import type { SearchHit, SearchResults } from '../api/types.js';
import { useApi } from '../app/services.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { useDebouncedValue } from '../lib/hooks.js';

export const SEARCH_DELAY_MS = 250;
export const MIN_QUERY_LENGTH = 2;

/** The quick actions the member may use (GET /search/actions), loaded once per session. */
export function useQuickActions() {
  const api = useApi();
  return useQuery({
    queryKey: ['quick-actions'],
    queryFn: () => api.quickActions(),
    staleTime: Infinity,
  });
}

interface Group {
  readonly key: string;
  readonly label: MessageKey;
  readonly items: readonly SearchHit[];
}

const RESULT_GROUPS = [
  ['parties', 'search.parties'],
  ['products', 'search.products'],
  ['leads', 'search.leads'],
  ['opportunities', 'search.opportunities'],
  ['projects', 'search.projects'],
  ['contracts', 'search.contracts'],
  ['loyalty', 'search.loyalty'],
  ['documents', 'search.documents'],
] as const satisfies readonly (readonly [keyof SearchResults, MessageKey])[];

export const actionHit = (action: QuickAction): SearchHit => ({
  id: action.key,
  title: action.label,
  subtitle: action.shortcut,
  path: action.path,
});

/** The groups to show, in order, leaving out empty ones and ones the member cannot see. */
export function resultGroups(results: SearchResults): Group[] {
  const groups: Group[] = [
    { key: 'actions', label: 'search.actions', items: results.actions.map(actionHit) },
    ...RESULT_GROUPS.map(([key, label]) => ({ key, label, items: results[key] ?? [] })),
  ];
  return groups.filter((group) => group.items.length > 0);
}

/**
 * The one search box (GET /search): customers, products, leads, projects,
 * loyalty accounts and documents, grouped, plus quick actions. Arrow keys move, Enter opens, Escape closes.
 */
export function SearchBox({ inputRef }: { readonly inputRef: RefObject<HTMLInputElement | null> }) {
  const api = useApi();
  const { t } = useI18n();
  const navigate = useNavigate();
  const listboxId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const term = useDebouncedValue(query.trim(), SEARCH_DELAY_MS);
  const searching = term.length >= MIN_QUERY_LENGTH;

  const actions = useQuickActions();
  const results = useQuery({
    queryKey: ['search', term],
    queryFn: ({ signal }) => api.search(term, signal),
    enabled: open && searching,
  });

  const groups: Group[] = searching
    ? results.data
      ? resultGroups(results.data)
      : []
    : [{ key: 'actions', label: 'search.actions', items: (actions.data ?? []).map(actionHit) }];
  const options = groups.flatMap((group) => group.items);
  const optionId = (index: number) => `${listboxId}-${String(index)}`;
  const activeIndex = Math.min(active, options.length - 1);

  const choose = (hit: SearchHit) => {
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
    void navigate(hit.path);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      if (open) setOpen(false);
      else setQuery('');
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
    event.preventDefault();
    setOpen(true);
    if (options.length === 0) return;
    if (event.key === 'Enter') {
      const hit = options[activeIndex];
      if (hit && open) choose(hit);
      return;
    }
    const step = event.key === 'ArrowDown' ? 1 : -1;
    setActive((activeIndex + step + options.length) % options.length);
  };

  let status: string | null = null;
  if (searching && results.isError) status = t('search.error');
  else if (searching && results.isSuccess && options.length === 0) {
    status = t('search.noResults', { query: term });
  } else if (query.trim().length === 1) status = t('search.minLength');

  // Position of each group's first option in the flat list the arrow keys move through.
  const starts = groups.map((_, at) =>
    groups.slice(0, at).reduce((count, group) => count + group.items.length, 0),
  );
  return (
    <div className="search" data-open={open ? '' : undefined}>
      <label className="search__field">
        <Icon name="search" className="search__icon" />
        <span className="ui-visually-hidden">{t('search.label')}</span>
        <input
          ref={inputRef}
          className="ui-input search__input"
          type="search"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          placeholder={t('search.placeholder')}
          autoComplete="off"
          enterKeyHint="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
          }}
          onBlur={() => {
            setOpen(false);
          }}
          onKeyDown={onKeyDown}
        />
      </label>
      {open && (
        <div className="search__panel">
          {searching && results.isFetching && (
            <div className="search__status">
              <Spinner size="sm" label={t('common.loading')} />
            </div>
          )}
          {status !== null && (
            <p className="search__status" role="status">
              {status}
            </p>
          )}
          <ul id={listboxId} role="listbox" aria-label={t('search.label')} className="search__list">
            {groups.map((group, groupIndex) => (
              <li key={group.key} role="presentation">
                <ul role="group" aria-label={t(group.label)}>
                  <li role="presentation" className="search__group" aria-hidden="true">
                    {t(group.label)}
                  </li>
                  {group.items.map((hit, hitIndex) => {
                    const position = Number(starts[groupIndex]) + hitIndex;
                    return (
                      <li
                        key={`${group.key}-${hit.id}`}
                        id={optionId(position)}
                        role="option"
                        aria-selected={position === activeIndex}
                        className="search__option"
                        // Keep focus in the box so the click lands before it closes.
                        onMouseDown={(event) => {
                          event.preventDefault();
                        }}
                        onClick={() => {
                          choose(hit);
                        }}
                      >
                        <span className="search__title">{hit.title}</span>
                        {hit.subtitle !== null && (
                          <span className="search__subtitle">{hit.subtitle}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
