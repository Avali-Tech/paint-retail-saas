import { Badge, Button, Card, PageHeader, Table, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import type { Transfer } from '../api/transfers.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { ReasonDialog } from '../lib/ReasonDialog.js';
import { useStoreAccess } from '../stock/StoreSelect.js';
import { ChallanCard } from './Challan.js';
import { TRANSFER_TONE } from './quantity.js';
import { QuantitiesDialog, ReceiveDialog } from './TransferDialogs.js';
import { refreshInventory } from '../lib/refresh.js';

type Action = 'approve' | 'reject' | 'dispatch' | 'receive' | 'cancel';

function Timeline({ transfer }: { readonly transfer: Transfer }) {
  const { t, dateTime } = useI18n();
  const steps: [MessageKey, string | null][] = [
    ['transfers.detail.requestedAt', transfer.requestedAt],
    ['transfers.detail.approvedAt', transfer.approvedAt],
    ['transfers.detail.dispatchedAt', transfer.dispatchedAt],
    ['transfers.detail.receivedAt', transfer.receivedAt],
    ['transfers.detail.closedAt', transfer.closedAt],
  ];
  return (
    <ol className="timeline" aria-label={t('transfers.detail.timeline')}>
      {steps
        .filter((step): step is [MessageKey, string] => step[1] !== null)
        .map(([key, time]) => (
          <li key={key} data-done="">
            {t(key, { time: dateTime(time) })}
          </li>
        ))}
    </ol>
  );
}

function TransferView({ transfer }: { readonly transfer: Transfer }) {
  const api = useApi();
  const { t, label, number } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const can = usePermissions();
  const access = useStoreAccess();
  const [action, setAction] = useState<Action | null>(null);
  const manage = can('inventory:manage');
  const sending = manage && access(transfer.from.id);
  const receiving = manage && access(transfer.to.id);
  const { status } = transfer;
  // What the sending store has matters until the stock leaves it.
  const beforeDispatch = status === 'requested' || status === 'approved';
  const quantity = (value: number | null) => (value === null ? t('common.none') : number(value));
  const close = () => {
    setAction(null);
  };

  /** Runs a step, keeps its answer and tells lists and balances to reload. */
  const run = async (work: Promise<Transfer>, done: MessageKey) => {
    let saved: Transfer;
    try {
      saved = await work;
    } catch (error) {
      // Refused: someone at the other store may have moved it on, so show it as it is now.
      await refreshInventory(queryClient);
      throw error;
    }
    queryClient.setQueryData(['transfer', saved.id], saved);
    await refreshInventory(queryClient, ['transfer', saved.id]);
    toast({ title: t(done), tone: 'success' });
  };

  const button = (name: Action, labelKey: MessageKey, variant: 'primary' | 'secondary') => (
    <Button
      variant={variant}
      aria-label={`${t(labelKey)} ${transfer.number}`}
      onClick={() => {
        setAction(name);
      }}
    >
      {t(labelKey)}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={transfer.number}
        description={
          <span className="badges">
            <Badge tone={TRANSFER_TONE[status]}>{label('transferStatus', status)}</Badge>
            <span className="muted">
              {t('transfers.detail.route', {
                from: `${transfer.from.code} · ${transfer.from.name}`,
                to: `${transfer.to.code} · ${transfer.to.name}`,
              })}
            </span>
          </span>
        }
        actions={
          <span className="row">
            {sending && status === 'requested' && (
              <>
                {button('approve', 'transfers.detail.approve', 'primary')}
                {button('reject', 'transfers.detail.reject', 'secondary')}
              </>
            )}
            {sending &&
              status === 'approved' &&
              button('dispatch', 'transfers.detail.dispatch', 'primary')}
            {receiving &&
              status === 'in_transit' &&
              button('receive', 'transfers.detail.receive', 'primary')}
            {receiving &&
              beforeDispatch &&
              button('cancel', 'transfers.detail.cancel', 'secondary')}
          </span>
        }
      />
      <div className="stack">
        <Card>
          <div className="stack">
            <Timeline transfer={transfer} />
            {transfer.note !== null && <p>{t('transfers.detail.note', { note: transfer.note })}</p>}
            {transfer.closingReason !== null && (
              <p>{t('transfers.detail.closingReason', { reason: transfer.closingReason })}</p>
            )}
          </div>
        </Card>
        <Card title={t('transfers.detail.lines')}>
          <Table label={t('transfers.detail.lines')}>
            <thead>
              <tr>
                <th scope="col">{t('transfers.detail.product')}</th>
                <th scope="col" className="ui-num">
                  {t('transfers.detail.requested')}
                </th>
                {beforeDispatch && (
                  <th scope="col" className="ui-num">
                    {t('transfers.detail.availableAtSource', { store: transfer.from.code })}
                  </th>
                )}
                <th scope="col" className="ui-num">
                  {t('transfers.detail.approved')}
                </th>
                <th scope="col" className="ui-num">
                  {t('transfers.detail.dispatched')}
                </th>
                <th scope="col" className="ui-num">
                  {t('transfers.detail.received')}
                </th>
                <th scope="col" className="ui-num">
                  {t('transfers.detail.damaged')}
                </th>
                <th scope="col" className="ui-num">
                  {t('transfers.detail.short')}
                </th>
              </tr>
            </thead>
            <tbody>
              {transfer.lines.map((line) => (
                <tr key={line.variantId}>
                  <th scope="row">
                    {line.sku}
                    <span className="cell-meta">
                      {line.brandName} {line.productName} · {String(line.packSize)} {line.unit}
                    </span>
                  </th>
                  <td className="ui-num">{number(line.requestedQuantity)}</td>
                  {beforeDispatch && <td className="ui-num">{number(line.availableAtSource)}</td>}
                  <td className="ui-num">{quantity(line.approvedQuantity)}</td>
                  <td className="ui-num">{quantity(line.dispatchedQuantity)}</td>
                  <td className="ui-num">{quantity(line.receivedQuantity)}</td>
                  <td className="ui-num">{quantity(line.damagedQuantity)}</td>
                  <td className="ui-num">{quantity(line.shortQuantity)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        {transfer.dispatchedAt !== null && <ChallanCard transferId={transfer.id} />}
      </div>

      {action === 'approve' && (
        <QuantitiesDialog
          transfer={transfer}
          title={t('transfers.detail.approveTitle', { number: transfer.number })}
          description={t('transfers.detail.approveDescription')}
          submitLabel={t('transfers.detail.approve')}
          fieldLabel="transfers.detail.approveQuantity"
          max={(line) => line.requestedQuantity}
          onClose={close}
          onSubmit={(lines) =>
            run(api.transfers.approve(transfer.id, lines), 'transfers.detail.approveDone')
          }
        />
      )}
      {action === 'dispatch' && (
        <QuantitiesDialog
          transfer={transfer}
          title={t('transfers.detail.dispatchTitle', { number: transfer.number })}
          description={t('transfers.detail.dispatchDescription', { store: transfer.from.name })}
          submitLabel={t('transfers.detail.dispatch')}
          fieldLabel="transfers.detail.dispatchQuantity"
          max={(line) => Number(line.approvedQuantity)}
          onClose={close}
          onSubmit={(lines) =>
            run(api.transfers.dispatch(transfer.id, lines), 'transfers.detail.dispatchDone')
          }
        />
      )}
      {action === 'receive' && (
        <ReceiveDialog
          transfer={transfer}
          onClose={close}
          onSubmit={(input) =>
            run(api.transfers.receive(transfer.id, input), 'transfers.detail.receivedDone')
          }
        />
      )}
      {action === 'reject' && (
        <ReasonDialog
          title={t('transfers.detail.rejectTitle', { number: transfer.number })}
          submitLabel={t('transfers.detail.reject')}
          onClose={close}
          onSubmit={(reason) =>
            run(api.transfers.reject(transfer.id, reason), 'transfers.detail.rejected')
          }
        />
      )}
      {action === 'cancel' && (
        <ReasonDialog
          title={t('transfers.detail.cancelTitle', { number: transfer.number })}
          submitLabel={t('transfers.detail.cancel')}
          onClose={close}
          onSubmit={(reason) =>
            run(api.transfers.cancel(transfer.id, reason), 'transfers.detail.cancelled')
          }
        />
      )}
    </>
  );
}

/** /transfers/:id */
export function TransferDetailPage() {
  const api = useApi();
  const id = String(useParams().id);
  const transfer = useQuery({
    queryKey: ['transfer', id],
    queryFn: ({ signal }) => api.transfers.get(id, signal),
  });
  return (
    <QueryState query={transfer} error="transfers.detail.error">
      {(data) => <TransferView transfer={data} />}
    </QueryState>
  );
}
