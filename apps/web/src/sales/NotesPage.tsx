import { Card, EmptyState, Field, Icon, Input, PageHeader, Select } from '@paint/ui';
import type { NoteKind } from '@paint/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { useDebouncedValue, useUrlFilters } from '../lib/hooks.js';
import { ListPager, ListRefreshing } from '../lib/ListPager.js';
import { QueryState } from '../lib/QueryState.js';
import { PAGE_SIZE } from './InvoicesPage.js';
import { NotesTable } from './NotesTable.js';

/** Waits for typing to pause before searching (as the MVP 1 lists do). */
const SEARCH_DELAY_MS = 300;
const FILTERS = ['kind', 'q'] as const;
const KINDS: readonly NoteKind[] = ['credit_note', 'debit_note'];

/** /notes — credit and debit notes of the member's stores, newest first. */
export function NotesPage() {
  const api = useApi();
  const { t, label } = useI18n();
  const filters = useUrlFilters(FILTERS);
  const kind = KINDS.find((value) => value === filters.values.kind);
  const q = useDebouncedValue(filters.values.q.trim(), SEARCH_DELAY_MS);
  const notes = useQuery({
    queryKey: ['notes', { kind, q, offset: filters.offset, cursor: filters.cursor }],
    queryFn: ({ signal }) =>
      api.sales.notes(
        {
          kind,
          q: q === '' ? undefined : q,
          limit: PAGE_SIZE,
          offset: filters.offset,
          cursor: filters.cursor,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader title={t('sales.notes.title')} description={t('sales.notes.description')} />
      <Card>
        <div className="filters">
          <Field label={t('sales.notes.search')} className="filters__search">
            <Input
              type="search"
              value={filters.values.q}
              onChange={(event) => {
                filters.set('q', event.target.value);
              }}
            />
          </Field>
          <Field label={t('sales.notes.kind')}>
            <Select
              value={kind ?? ''}
              onChange={(event) => {
                filters.set('kind', event.target.value);
              }}
            >
              <option value="">{t('sales.notes.all')}</option>
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {label('taxDocumentKinds', value)}
                </option>
              ))}
            </Select>
          </Field>
          <ListRefreshing query={notes} />
        </div>
        <QueryState query={notes} error="sales.notes.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState icon={<Icon name="search" size={32} />} title={t('sales.notes.empty')} />
            ) : (
              <>
                <NotesTable notes={page.items} title={t('sales.notes.title')} />
                <ListPager
                  filters={filters}
                  page={page}
                  limit={PAGE_SIZE}
                  label={t('sales.notes.pages')}
                />
              </>
            )
          }
        </QueryState>
      </Card>
    </>
  );
}
