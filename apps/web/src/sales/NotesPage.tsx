import { Card, EmptyState, Field, Icon, PageHeader, Pagination, Select } from '@paint/ui';
import type { NoteKind } from '@paint/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { PAGE_SIZE } from './InvoicesPage.js';
import { NotesTable } from './NotesTable.js';

const FILTERS = ['kind'] as const;
const KINDS: readonly NoteKind[] = ['credit_note', 'debit_note'];

/** /notes — credit and debit notes of the member's stores, newest first. */
export function NotesPage() {
  const api = useApi();
  const { t, label } = useI18n();
  const filters = useUrlFilters(FILTERS);
  const kind = KINDS.find((value) => value === filters.values.kind);
  const notes = useQuery({
    queryKey: ['notes', { kind, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.sales.notes({ kind, limit: PAGE_SIZE, offset: filters.offset }, signal),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader title={t('sales.notes.title')} description={t('sales.notes.description')} />
      <Card>
        <div className="filters">
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
        </div>
        <QueryState query={notes} error="sales.notes.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState icon={<Icon name="search" size={32} />} title={t('sales.notes.empty')} />
            ) : (
              <>
                <NotesTable notes={page.items} title={t('sales.notes.title')} />
                <Pagination
                  offset={filters.offset}
                  limit={PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('sales.notes.pages')}
                  range={(from, to, total) => t('common.range', { from, to, total })}
                  previousLabel={t('common.previous')}
                  nextLabel={t('common.next')}
                />
              </>
            )
          }
        </QueryState>
      </Card>
    </>
  );
}
