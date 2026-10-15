import { AGEING_BUCKETS, type SiteAccountDetail } from '@paint/shared';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Table,
  Textarea,
  useToast,
} from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { rupeesInput } from '../lib/inputs.js';
import { QueryState } from '../lib/QueryState.js';
import { REASON_MIN } from './approval-parts.js';
import { SITE_TONE, readSiteLimit } from './SiteAccounts.js';

function SiteDetail({ site }: { readonly site: SiteAccountDetail }) {
  const api = useApi();
  const { t, money, label, date, number, dateTime } = useI18n();
  const can = usePermissions();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'hold' | 'edit' | null>(null);
  const [text, setText] = useState('');
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['site-accounts', site.id] }),
      queryClient.invalidateQueries({ queryKey: ['party'] }),
    ]);
  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      await refresh();
      toast({ title: done, tone: 'success' });
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const closed = site.status === 'closed';
  const facts: [string, string][] = [
    [t('sites.limit'), money(site.limitPaise)],
    [t('sites.outstanding'), money(site.outstandingPaise)],
    [t('sites.openOrders'), money(site.openOrdersPaise)],
    [t('sites.owes'), money(site.exposurePaise)],
    [t('sites.available'), money(site.availablePaise)],
    [t('sites.used'), t('credit.percent', { value: number(Number(site.utilizationPercent)) })],
  ];
  if (site.hold !== null) {
    facts.push([
      t('sites.heldBy'),
      t('approvals.byOn', { name: site.hold.by.name, when: dateTime(site.hold.at) }),
    ]);
    facts.push([t('credit.reason'), site.hold.reason]);
  }
  if (site.notes !== null) facts.push([t('sites.notes'), site.notes]);
  return (
    <>
      <PageHeader
        title={t('sites.detailTitle', { name: site.project.name })}
        description={
          <>
            <Link to={`/parties/${site.party.id}`}>{site.party.name}</Link>
            {' · '}
            <Link to={`/projects/${site.project.id}`}>{site.project.number}</Link>
          </>
        }
        actions={
          closed ? undefined : (
            <div className="row">
              {can('credit:manage') && site.status === 'active' && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setText('');
                    setDialog('hold');
                  }}
                >
                  {t('sites.hold')}
                </Button>
              )}
              {can('credit:approve') && site.status === 'on_hold' && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  onClick={() => {
                    void act(() => api.credit.releaseSite(site.id), t('sites.released'));
                  }}
                >
                  {t('sites.release')}
                </Button>
              )}
              {can('credit:approve') && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setLimit(rupeesInput(site.limitPaise));
                      setText(site.notes ?? '');
                      setDialog('edit');
                    }}
                  >
                    {t('sites.edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={busy}
                    onClick={() => {
                      void act(() => api.credit.closeSite(site.id), t('sites.closed'));
                    }}
                  >
                    {t('sites.close')}
                  </Button>
                </>
              )}
            </div>
          )
        }
      />
      <Card
        title={t('sites.position')}
        actions={
          <Badge tone={SITE_TONE[site.status]}>{label('siteAccountStatus', site.status)}</Badge>
        }
      >
        <dl className="facts">
          {facts.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title={t('sites.ageing')}>
        <dl className="facts" aria-label={t('sites.ageing')}>
          {AGEING_BUCKETS.map((bucket) => (
            <div key={bucket}>
              <dt>{label('ageingBucket', bucket)}</dt>
              <dd>{money(site.ageing[bucket])}</dd>
            </div>
          ))}
        </dl>
        {site.openDocuments.length > 0 && (
          <Table label={t('sites.openDocuments')}>
            <thead>
              <tr>
                <th scope="col">{t('sites.document')}</th>
                <th scope="col">{t('sites.due')}</th>
                <th scope="col">{t('sites.outstanding')}</th>
                <th scope="col">{t('sites.bucket')}</th>
              </tr>
            </thead>
            <tbody>
              {site.openDocuments.map((document) => (
                <tr key={document.documentId}>
                  <th scope="row">
                    <Link to={`/invoices/${document.documentId}`}>{String(document.number)}</Link>
                    <span className="cell-meta">{date(document.issuedOn)}</span>
                  </th>
                  <td>{document.dueOn === null ? t('common.none') : date(document.dueOn)}</td>
                  <td>{money(document.outstandingPaise)}</td>
                  <td>{label('ageingBucket', document.bucket)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card title={t('sites.ledger')}>
        {site.ledger.length === 0 ? (
          <p className="muted">{t('sites.noLedger')}</p>
        ) : (
          <Table label={t('sites.ledger')}>
            <thead>
              <tr>
                <th scope="col">{t('sites.on')}</th>
                <th scope="col">{t('sites.entry')}</th>
                <th scope="col">{t('sites.amount')}</th>
                <th scope="col">{t('sites.running')}</th>
              </tr>
            </thead>
            <tbody>
              {site.ledger.map((entry, index) => (
                <tr key={`${entry.documentId}-${String(index)}`}>
                  <td>{date(entry.on)}</td>
                  <th scope="row">
                    {label('siteLedgerKind', entry.kind)} {entry.number ?? ''}
                    {entry.againstNumber !== null && (
                      <span className="cell-meta">
                        {t('sites.against', { number: entry.againstNumber })}
                      </span>
                    )}
                  </th>
                  <td>{money(entry.amountPaise)}</td>
                  <td>{money(entry.runningPaise)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <FormDialog
        open={dialog === 'hold'}
        onClose={() => {
          setDialog(null);
        }}
        title={t('sites.holdTitle')}
        submitLabel={t('sites.hold')}
        onSubmit={async () => {
          const reason = text.trim();
          if (reason.length < REASON_MIN) return t('approvals.reasonInvalid');
          await api.credit.holdSite(site.id, reason);
          await refresh();
          toast({ title: t('sites.held'), tone: 'success' });
          return undefined;
        }}
      >
        <Field label={t('credit.reason')}>
          <Textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        </Field>
      </FormDialog>
      <FormDialog
        open={dialog === 'edit'}
        onClose={() => {
          setDialog(null);
        }}
        title={t('sites.editTitle')}
        submitLabel={t('common.save')}
        onSubmit={async () => {
          // The party's limit is checked by the API; here only the amount.
          const read = readSiteLimit(limit, Number.MAX_SAFE_INTEGER);
          if (typeof read !== 'number') return t('sites.limitInvalid');
          const note = text.trim();
          await api.credit.updateSite(site.id, {
            limitPaise: read,
            notes: note === '' ? null : note,
          });
          await refresh();
          toast({ title: t('sites.saved'), tone: 'success' });
          return undefined;
        }}
      >
        <Field label={t('sites.limitLabel')}>
          <Input
            inputMode="decimal"
            value={limit}
            onChange={(event) => {
              setLimit(event.target.value);
            }}
          />
        </Field>
        <Field label={t('sites.notes')}>
          <Textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        </Field>
      </FormDialog>
    </>
  );
}

/** /site-accounts/:id — one site account: its position, ageing and ledger. */
export function SiteAccountPage() {
  const api = useApi();
  // The route always has an :id.
  const id = String(useParams().id);
  const site = useQuery({
    queryKey: ['site-accounts', id],
    queryFn: ({ signal }) => api.credit.site(id, signal),
  });
  return (
    <QueryState query={site} error="sites.error">
      {(data) => <SiteDetail site={data} />}
    </QueryState>
  );
}
