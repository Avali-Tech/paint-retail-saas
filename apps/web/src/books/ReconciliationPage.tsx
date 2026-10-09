import { Alert, Button, Card, PageHeader, Table, useToast } from '@paint/ui';
import {
  isStockFinding,
  type ReconciliationFindingView,
  type ReconciliationRunView,
} from '@paint/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { AccountingNav } from './AccountingNav.js';

const latestKey = ['reconciliation', 'latest'] as const;

/** What a finding is about: a store's pack, or a party. */
function Subject({ finding }: { readonly finding: ReconciliationFindingView }) {
  return finding.variant === null ? (
    <>{finding.party?.name}</>
  ) : (
    <>
      {finding.variant.sku} · {finding.variant.name}
      <span className="cell-meta">{finding.store?.name}</span>
    </>
  );
}

function Findings({ run }: { readonly run: ReconciliationRunView }) {
  const { t, label, money, number } = useI18n();
  const figure = (finding: ReconciliationFindingView, value: number) =>
    isStockFinding(finding.kind) ? number(value) : money(value);
  return (
    <Table label={t('books.reconciliation.findings')}>
      <thead>
        <tr>
          <th scope="col">{t('books.reconciliation.kind')}</th>
          <th scope="col">{t('books.reconciliation.subject')}</th>
          <th scope="col" className="num">
            {t('books.reconciliation.recorded')}
          </th>
          <th scope="col" className="num">
            {t('books.reconciliation.expected')}
          </th>
          <th scope="col" className="num">
            {t('books.reconciliation.difference')}
          </th>
        </tr>
      </thead>
      <tbody>
        {run.findings.map((finding) => (
          <tr key={finding.id}>
            <th scope="row">{label('reconciliationKinds', finding.kind)}</th>
            <td>
              <Subject finding={finding} />
              {finding.advancePaise !== null && (
                <span className="cell-meta">
                  {t('books.reconciliation.advance', {
                    advance: money(finding.advancePaise),
                    unallocated: money(Number(finding.unallocatedPaise)),
                  })}
                </span>
              )}
            </td>
            <td className="num">{figure(finding, finding.recorded)}</td>
            <td className="num">{figure(finding, finding.expected)}</td>
            <td className="num">{figure(finding, finding.difference)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** The run: when and why it ran, and whether the books agree. */
function LatestRun({ run }: { readonly run: ReconciliationRunView }) {
  const { t, label, dateTime, plural } = useI18n();
  return (
    <div className="stack">
      <dl className="facts" aria-label={t('books.reconciliation.about')}>
        <div>
          <dt>{t('books.reconciliation.ranAt')}</dt>
          <dd>{dateTime(run.ranAt)}</dd>
        </div>
        <div>
          <dt>{t('books.reconciliation.trigger')}</dt>
          <dd>
            {run.requestedBy === null
              ? label('reconciliationTriggers', run.trigger)
              : t('books.reconciliation.requestedBy', { name: run.requestedBy.name })}
          </dd>
        </div>
        <div>
          <dt>{t('books.reconciliation.findingCount')}</dt>
          <dd>{run.findingCount}</dd>
        </div>
      </dl>
      {run.findingCount === 0 ? (
        <Alert tone="success">{t('books.reconciliation.balanced')}</Alert>
      ) : (
        <>
          <Alert tone="danger">{plural('books.reconciliation.unbalanced', run.findingCount)}</Alert>
          <Findings run={run} />
        </>
      )}
    </div>
  );
}

/**
 * /accounting/reconciliation — the nightly check of the books (spec §3.3, §4.6):
 * stock on hand and reserved, party balances and allocations against the rows
 * they sum, with "Run now".
 */
export function ReconciliationPage() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const latest = useQuery({
    queryKey: latestKey,
    queryFn: ({ signal }) => api.books.latestReconciliation(signal),
  });

  const runNow = async () => {
    setMessage(null);
    setPending(true);
    try {
      const run = await api.books.runReconciliation();
      queryClient.setQueryData(latestKey, { run });
      toast({ title: t('books.reconciliation.done'), tone: 'success' });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('books.reconciliation.title')}
        description={t('books.reconciliation.description')}
        actions={
          <Button
            loading={pending}
            onClick={() => {
              void runNow();
            }}
          >
            {t('books.reconciliation.run')}
          </Button>
        }
      />
      <AccountingNav />
      <Card title={t('books.reconciliation.latest')}>
        <div className="stack">
          {message !== null && <Alert tone="danger">{message}</Alert>}
          <QueryState query={latest} error="books.reconciliation.error">
            {({ run }) =>
              run === null ? (
                <p className="muted">{t('books.reconciliation.never')}</p>
              ) : (
                <LatestRun run={run} />
              )
            }
          </QueryState>
        </div>
      </Card>
    </>
  );
}
