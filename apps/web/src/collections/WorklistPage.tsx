import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  PageHeader,
  Pagination,
  Select,
  Table,
  Textarea,
  buttonStyle,
  useToast,
  type Tone,
} from '@paint/ui';
import type { NextStep, WorklistPage as Page, WorklistRow } from '@paint/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { SendPaymentLinkButton } from '../payment-links/PaymentLinks.js';
import { PromiseDialog, refreshCollections } from './PromiseDialog.js';

export const WORKLIST_PAGE_SIZE = 50;
const FILTERS = ['whose'] as const;
const WHOSE = ['me', 'all', 'none'] as const;
type Whose = (typeof WHOSE)[number];

const STEP_TONE: Record<NextStep, Tone> = {
  acknowledge_escalation: 'danger',
  follow_up_promise: 'warning',
  await_promise: 'neutral',
  contact: 'primary',
};

/** The worklist's salesperson filter: the member's own customers unless they choose. */
export function whoseFilter(value: string): { whose: Whose; salespersonId?: string } {
  const whose = WHOSE.find((option) => option === value) ?? 'me';
  return whose === 'all' ? { whose } : { whose, salespersonId: whose };
}

function AcknowledgeDialog({
  row,
  onClose,
}: {
  readonly row: WorklistRow;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('collections.acknowledgeTitle')}
      description={t('collections.acknowledgeDescription')}
      submitLabel={t('collections.acknowledge')}
      onSubmit={async () => {
        await api.collections.acknowledge(
          String(row.openEscalationId),
          note.trim() === '' ? undefined : note.trim(),
        );
        await refreshCollections(queryClient);
        toast({ title: t('collections.acknowledged'), tone: 'success' });
        return undefined;
      }}
    >
      <Field label={t('collections.acknowledgeNote')}>
        <Textarea
          maxLength={1000}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

function Rows({ page }: { readonly page: Page }) {
  const { t, label, money, date, relativeTime } = useI18n();
  const manage = usePermissions()('credit:manage');
  const [promising, setPromising] = useState<WorklistRow | null>(null);
  const [acknowledging, setAcknowledging] = useState<WorklistRow | null>(null);
  return (
    <>
      <Table label={t('collections.table')}>
        <thead>
          <tr>
            <th scope="col">{t('collections.customer')}</th>
            <th scope="col">{t('collections.salesperson')}</th>
            <th scope="col" className="ui-num">
              {t('collections.overdue')}
            </th>
            <th scope="col" className="ui-num">
              {t('collections.late')}
            </th>
            <th scope="col">{t('collections.lastContact')}</th>
            <th scope="col">{t('collections.promise')}</th>
            <th scope="col">{t('collections.nextStep')}</th>
            <th scope="col">{t('collections.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {page.rows.map((row) => (
            <tr key={row.partyId}>
              <td>
                <Link to={`/parties/${row.partyId}/ledger`}>{row.name}</Link>
                {row.phone !== null && <div className="muted">{row.phone}</div>}
              </td>
              <td>{row.salesperson?.name ?? t('collections.unassigned')}</td>
              <td className="ui-num">{money(row.overduePaise)}</td>
              <td className="ui-num">{row.maxDaysPastDue}</td>
              <td>
                {row.lastActivity === null ? (
                  t('collections.never')
                ) : (
                  <>
                    {row.lastActivity.subject}
                    <div className="muted">
                      {label('activityTypes', row.lastActivity.type)} ·{' '}
                      {relativeTime(row.lastActivity.at)}
                    </div>
                  </>
                )}
              </td>
              <td>
                {row.openPromise === null ? (
                  t('collections.noPromise')
                ) : (
                  <>
                    {t('collections.promiseSummary', {
                      amount: money(row.openPromise.amountPaise),
                      date: date(row.openPromise.promisedOn),
                    })}
                    <div className="muted">
                      {t('collections.paidSoFar', { amount: money(row.openPromise.paidPaise) })}
                    </div>
                  </>
                )}
              </td>
              <td>
                <Badge tone={STEP_TONE[row.nextStep]}>{label('nextSteps', row.nextStep)}</Badge>
              </td>
              <td>
                <span className="row">
                  {row.phone !== null && (
                    <a
                      {...buttonStyle('ghost', 'sm')}
                      href={`tel:${row.phone}`}
                      aria-label={t('collections.callName', { name: row.name })}
                    >
                      {t('collections.call')}
                    </a>
                  )}
                  {manage && row.openEscalationId !== null && (
                    <Button
                      size="sm"
                      aria-label={t('collections.acknowledgeName', { name: row.name })}
                      onClick={() => {
                        setAcknowledging(row);
                      }}
                    >
                      {t('collections.acknowledge')}
                    </Button>
                  )}
                  <SendPaymentLinkButton party={{ id: row.partyId, name: row.name }} size="sm" />
                  {manage && row.openPromise === null && (
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={t('collections.recordName', { name: row.name })}
                      onClick={() => {
                        setPromising(row);
                      }}
                    >
                      {t('collections.record')}
                    </Button>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {promising !== null && (
        <PromiseDialog
          party={{ id: promising.partyId, name: promising.name }}
          owedPaise={promising.outstandingPaise}
          onClose={() => {
            setPromising(null);
          }}
        />
      )}
      {acknowledging !== null && (
        <AcknowledgeDialog
          row={acknowledging}
          onClose={() => {
            setAcknowledging(null);
          }}
        />
      )}
    </>
  );
}

/** /collections — the collections worklist (P2-M11). */
export function WorklistPage() {
  const api = useApi();
  const { t, plural, money, number } = useI18n();
  const filters = useUrlFilters(FILTERS);
  const { whose, salespersonId } = whoseFilter(filters.values.whose);
  const query = {
    salespersonId,
    limit: WORKLIST_PAGE_SIZE,
    offset: filters.offset,
  };
  const worklist = useQuery({
    queryKey: ['collections', 'worklist', query],
    queryFn: ({ signal }) => api.collections.worklist(query, signal),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader
        title={t('collections.title')}
        description={t('collections.description')}
        actions={
          <Link to="/collections/reminders" {...buttonStyle('secondary')}>
            {t('collections.reminders')}
          </Link>
        }
      />
      <Card>
        <div className="filters">
          <Field label={t('collections.whose')}>
            <Select
              value={whose}
              onChange={(event) => {
                filters.set('whose', event.target.value === 'me' ? '' : event.target.value);
              }}
            >
              {WHOSE.map((option) => (
                <option key={option} value={option}>
                  {t(`collections.whoseOptions.${option}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>
      <QueryState query={worklist} error="collections.error">
        {(page) =>
          page.total === 0 ? (
            <EmptyState title={t('collections.empty')} />
          ) : (
            <Card
              title={plural('collections.summary', page.total, {
                amount: money(page.overduePaise),
              })}
            >
              <div className="stack">
                <Rows page={page} />
                <Pagination
                  offset={filters.offset}
                  limit={WORKLIST_PAGE_SIZE}
                  total={page.total}
                  onChange={(offset) => {
                    filters.setOffset(offset);
                  }}
                  label={t('collections.pages')}
                  range={(from, to, all) =>
                    t('common.range', { from: number(from), to: number(to), total: number(all) })
                  }
                  previousLabel={t('common.previous')}
                  nextLabel={t('common.next')}
                />
              </div>
            </Card>
          )
        }
      </QueryState>
    </>
  );
}
