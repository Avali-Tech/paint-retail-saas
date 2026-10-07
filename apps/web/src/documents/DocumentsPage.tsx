import { Card, EmptyState, Field, Icon, Input, PageHeader, Pagination, Select } from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_PERMISSIONS,
  DOCUMENT_RECORD_PATHS,
  DOCUMENT_RECORD_TYPES,
  type DocumentListItem,
  type DocumentQuery,
} from '../api/documents.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { dateRangeProblems } from '../lib/india-time.js';
import { QueryState } from '../lib/QueryState.js';
import { useMembers } from '../team/team-data.js';
import { DocumentRow, RemoveDocumentDialog } from './DocumentsPanel.js';

export const DOCUMENTS_PAGE_SIZE = 25;
const FILTERS = ['recordType', 'category', 'uploadedBy', 'from', 'to'] as const;

/** The record a document is on: its kind and its name, linked to its page where it has one. */
function RecordLink({ document }: { readonly document: DocumentListItem }) {
  const { t } = useI18n();
  const path = DOCUMENT_RECORD_PATHS[document.recordType];
  return (
    <>
      {t(`documents.recordTypes.${document.recordType}`)} ·{' '}
      {path === null ? (
        document.recordLabel
      ) : (
        <Link to={`${path}${document.recordId}`}>{document.recordLabel}</Link>
      )}
    </>
  );
}

/**
 * /documents — every document on the records the member can see, newest first,
 * filtered by kind of record, what it is, who uploaded it and India-time day;
 * download, and delete where the member may change the record.
 */
export function DocumentsPage() {
  const api = useApi();
  const { t, label } = useI18n();
  const can = usePermissions();
  const canSeeTeam = can('members:read');
  const members = useMembers({ enabled: canSeeTeam });
  const filters = useUrlFilters(FILTERS);
  const { uploadedBy, from, to } = filters.values;
  const [removing, setRemoving] = useState<DocumentListItem | null>(null);
  const problems = dateRangeProblems(from, to);
  const fromError = problems.from === undefined ? undefined : t(`documents.page.${problems.from}`);
  const toError = problems.to === undefined ? undefined : t(`documents.page.${problems.to}`);
  // Kinds of record the member can see; a value from the address only if it is one of them.
  const recordTypes = DOCUMENT_RECORD_TYPES.filter((type) => can(DOCUMENT_PERMISSIONS[type].read));
  const recordType = recordTypes.find((type) => type === filters.values.recordType);
  const category = DOCUMENT_CATEGORIES.find((value) => value === filters.values.category);
  // Only filters with a value, and dates only once they are valid.
  const query: DocumentQuery = {
    recordType,
    category,
    uploadedBy: uploadedBy === '' ? undefined : uploadedBy,
    from: from === '' || fromError !== undefined ? undefined : from,
    to: to === '' || toError !== undefined ? undefined : to,
    limit: DOCUMENTS_PAGE_SIZE,
    offset: filters.offset,
  };
  const documents = useQuery({
    queryKey: ['documents', 'all', query],
    queryFn: ({ signal }) => api.documents.browse(query, signal),
    placeholderData: keepPreviousData,
  });
  const filtered = [recordType ?? '', category ?? '', uploadedBy, from, to].some(
    (value) => value !== '',
  );
  const select = (
    key: 'recordType' | 'category' | 'uploadedBy',
    value: string,
    emptyLabel: string,
    options: readonly { readonly value: string; readonly label: string }[],
  ) => (
    <Field label={t(`documents.page.${key}`)}>
      <Select
        value={value}
        onChange={(event) => {
          filters.set(key, event.target.value);
        }}
      >
        <option value="">{emptyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </Field>
  );
  const date = (key: 'from' | 'to', value: string, error: string | undefined) => (
    <Field label={t(`documents.page.${key}`)} hint={t('documents.page.dateHint')} error={error}>
      <Input
        type="date"
        value={value}
        onChange={(event) => {
          filters.set(key, event.target.value);
        }}
      />
    </Field>
  );
  return (
    <>
      <PageHeader title={t('documents.page.title')} description={t('documents.page.description')} />
      <Card>
        <div className="filters">
          {select(
            'recordType',
            recordType ?? '',
            t('documents.page.allRecords'),
            recordTypes.map((type) => ({ value: type, label: t(`documents.recordTypes.${type}`) })),
          )}
          {select(
            'category',
            category ?? '',
            t('documents.page.allCategories'),
            DOCUMENT_CATEGORIES.map((value) => ({
              value,
              label: label('documentCategories', value),
            })),
          )}
          {select('uploadedBy', uploadedBy, t('documents.page.anyone'), [
            { value: 'me', label: t('documents.page.me') },
            ...(members.data ?? [])
              .filter((member) => member.isActive)
              .map((member) => ({ value: member.id, label: member.user.fullName })),
          ])}
          {date('from', from, fromError)}
          {date('to', to, toError)}
        </div>
        <QueryState query={documents} error="documents.error">
          {(page) =>
            page.total === 0 ? (
              filtered ? (
                <p className="muted">{t('documents.page.noMatches')}</p>
              ) : (
                <EmptyState
                  icon={<Icon name="contracts" size={32} />}
                  title={t('documents.page.empty')}
                  description={t('documents.page.emptyHint')}
                />
              )
            ) : (
              <div className="stack">
                <ul className="record-list">
                  {page.items.map((document) => (
                    <DocumentRow
                      key={document.id}
                      document={document}
                      canManage={can(DOCUMENT_PERMISSIONS[document.recordType].manage)}
                      onRemove={setRemoving}
                      record={<RecordLink document={document} />}
                    />
                  ))}
                </ul>
                <Pagination
                  offset={filters.offset}
                  limit={DOCUMENTS_PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('documents.page.pages')}
                  range={(first, last, total) =>
                    t('common.range', { from: first, to: last, total })
                  }
                  previousLabel={t('common.previous')}
                  nextLabel={t('common.next')}
                />
              </div>
            )
          }
        </QueryState>
      </Card>
      {removing !== null && (
        <RemoveDocumentDialog
          document={removing}
          onClose={() => {
            setRemoving(null);
          }}
        />
      )}
    </>
  );
}
