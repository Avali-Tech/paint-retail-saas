import { Badge, Button, Card, useToast, type Tone } from '@paint/ui';
import type { PromiseStatus } from '@paint/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { ReasonDialog } from '../lib/ReasonDialog.js';
import { PromiseDialog, refreshCollections } from './PromiseDialog.js';

const STATUS_TONE: Record<PromiseStatus, Tone> = {
  open: 'primary',
  kept: 'success',
  broken: 'danger',
  cancelled: 'neutral',
};

/**
 * A customer's promises to pay on its 360 page (P2-M11): the open one with what has
 * been paid towards it, earlier ones with how they ended, and, for members who chase
 * credit, recording a new promise or cancelling the open one.
 */
export function CollectionsPanel({ party }: { readonly party: { id: string; name: string } }) {
  const api = useApi();
  const { t, label, money, date } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const manage = usePermissions()('credit:manage');
  const [dialog, setDialog] = useState<'promise' | 'cancel' | null>(null);
  const promises = useQuery({
    queryKey: ['promises', party.id],
    queryFn: ({ signal }) => api.collections.promises(party.id, signal),
  });
  const close = () => {
    setDialog(null);
  };
  return (
    <Card title={t('collections.panel.title')}>
      <QueryState query={promises} error="collections.panel.error">
        {(list) => {
          const open = list.find((promise) => promise.status === 'open');
          const earlier = list.filter((promise) => promise.status !== 'open').slice(0, 5);
          return (
            <div className="stack">
              {open === undefined ? (
                <p className="muted">{t('collections.panel.none')}</p>
              ) : (
                <div>
                  <strong>
                    {t('collections.panel.open', {
                      amount: money(open.amountPaise),
                      date: date(open.promisedOn),
                    })}
                  </strong>
                  <div className="muted">
                    {t('collections.panel.paid', {
                      amount: money(open.paidPaise),
                      date: date(open.madeOn),
                    })}
                  </div>
                </div>
              )}
              {earlier.length > 0 && (
                <>
                  <h3 className="subheading">{t('collections.panel.history')}</h3>
                  <ul className="record-list">
                    {earlier.map((promise) => (
                      <li key={promise.id}>
                        <span className="record-list__title">
                          {t('collections.promiseSummary', {
                            amount: money(promise.amountPaise),
                            date: date(promise.promisedOn),
                          })}{' '}
                          <Badge tone={STATUS_TONE[promise.status]}>
                            {label('promiseStatus', promise.status)}
                          </Badge>
                        </span>
                        <span className="record-list__meta">
                          {promise.cancelReason ??
                            t('collections.paidSoFar', { amount: money(promise.paidPaise) })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {manage && (
                <div className="row">
                  {open === undefined ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setDialog('promise');
                      }}
                    >
                      {t('collections.record')}
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setDialog('cancel');
                      }}
                    >
                      {t('collections.panel.cancel')}
                    </Button>
                  )}
                </div>
              )}
              {dialog === 'promise' && (
                <PromiseDialog party={party} owedPaise={null} onClose={close} />
              )}
              {dialog === 'cancel' && open !== undefined && (
                <ReasonDialog
                  title={t('collections.panel.cancelTitle')}
                  submitLabel={t('collections.panel.cancel')}
                  onClose={close}
                  onSubmit={async (reason) => {
                    await api.collections.cancelPromise(open.id, reason);
                    await refreshCollections(queryClient);
                    toast({ title: t('collections.panel.cancelled'), tone: 'success' });
                  }}
                />
              )}
            </div>
          );
        }}
      </QueryState>
    </Card>
  );
}
