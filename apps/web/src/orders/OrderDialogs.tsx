import {
  REASON_MIN_LENGTH,
  type AdvanceRequiredRefusal,
  openQuantity,
  type CreditApproval,
  type InsufficientStockRefusal,
  type SalesOrderLineView,
  type SalesOrderView,
} from '@paint/shared';
import { Field, Input, Select, Textarea } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n, type I18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { parsePositiveQuantity } from '../lib/quantity.js';
import { useStores } from '../stock/stores.js';
import { useCanOverride } from './OrderCredit.js';

/** Everything about the order loads again (its lines, stock, credit and invoices). */
export async function refreshOrder(
  queryClient: ReturnType<typeof useQueryClient>,
  order: SalesOrderView,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['sales-orders'] }),
    queryClient.invalidateQueries({ queryKey: ['invoices'] }),
    queryClient.invalidateQueries({ queryKey: ['party', order.billTo.id] }),
  ]);
}

/**
 * A confirm refusal spelled out: the lines a store cannot reserve, line by line, or a
 * partial order's advance short of the minimum. Null for any other error.
 */
export function confirmRefusalText(
  error: unknown,
  t: I18n['t'],
  number: I18n['number'],
  money: I18n['money'],
) {
  if (!(error instanceof ApiError)) return null;
  if (error.body.code === 'advance_required') {
    const refusal = error.body as unknown as AdvanceRequiredRefusal;
    return t('orders.confirm.advanceShort', {
      required: money(refusal.advanceRequiredPaise),
      advance: money(refusal.advancePaise),
    });
  }
  if (error.body.code !== 'insufficient_stock') return null;
  const { lines } = error.body as unknown as InsufficientStockRefusal;
  return [
    t('orders.confirm.short'),
    ...lines.map((line) =>
      t('orders.confirm.shortLine', {
        line: line.lineNo,
        wanted: number(line.wantedQuantity),
        available: number(line.availableQuantity),
      }),
    ),
  ].join(' ');
}

/**
 * "Confirm" (spec §5.3): runs the credit check, checks the advance and reserves the
 * stock. Past the credit rules, a member allowed to approve gives a reason and the
 * override is recorded on the order.
 */
export function ConfirmDialog({
  order,
  approval,
  onClose,
}: {
  readonly order: SalesOrderView;
  /** From the live credit check; "none" for prepaid and partial orders. */
  readonly approval: CreditApproval;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, number, money, label } = useI18n();
  const queryClient = useQueryClient();
  const canOverride = useCanOverride(order.storeId);
  const [reason, setReason] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const override = (approval === 'manager' || approval === 'owner') && canOverride(approval);
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('orders.confirm.title', { number: order.number })}
      description={t('orders.confirm.description')}
      submitLabel={override ? t('orders.confirm.approve') : t('orders.confirm.submit')}
      onSubmit={async () => {
        if (override && reason.trim().length < REASON_MIN_LENGTH) {
          return t('orders.confirm.reasonNeeded');
        }
        try {
          await api.orders.confirmOrder(
            order.id,
            override ? { creditOverride: { reason: reason.trim() } } : {},
            key,
          );
        } catch (error) {
          const short = confirmRefusalText(error, t, number, money);
          if (short !== null) return short;
          throw error;
        }
        await refreshOrder(queryClient, order);
        return undefined;
      }}
    >
      {override && (
        <Field
          label={t('orders.confirm.reason', { approval: label('creditApprovals', approval) })}
          hint={t('orders.confirm.reasonHint')}
          required
        >
          <Textarea
            maxLength={500}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </Field>
      )}
    </FormDialog>
  );
}

/** "Cancel line": part or all of what is still open, with a reason. */
export function CancelLineDialog({
  order,
  line,
  onClose,
}: {
  readonly order: SalesOrderView;
  readonly line: SalesOrderLineView;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, number } = useI18n();
  const queryClient = useQueryClient();
  const left = openQuantity(line);
  const [quantity, setQuantity] = useState(String(left));
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('orders.cancelLine.title', { item: line.description })}
      description={t('orders.cancelLine.description', { open: number(left) })}
      submitLabel={t('orders.cancelLine.submit')}
      onSubmit={async () => {
        const value = parsePositiveQuantity(quantity);
        if (value === null || value > left) return t('orders.cancelLine.quantityInvalid');
        if (reason.trim().length < REASON_MIN_LENGTH) return t('workflow.reasonInvalid');
        await api.orders.cancelLine(order.id, line.id, {
          ...(value === left ? {} : { quantity: value }),
          reason: reason.trim(),
        });
        await refreshOrder(queryClient, order);
        return undefined;
      }}
    >
      <Field label={t('orders.cancelLine.quantity')}>
        <Input
          inputMode="decimal"
          value={quantity}
          onChange={(event) => {
            setQuantity(event.target.value);
          }}
        />
      </Field>
      <Field label={t('workflow.reason')} required>
        <Textarea
          maxLength={500}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

/**
 * "Bill" (spec §5.3): a draft invoice for what is open at one fulfil store, all or
 * part of it, then issued. A prepaid or partial order uses the customer's advances.
 */
export function BillDialog({
  order,
  onClose,
}: {
  readonly order: SalesOrderView;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, number } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const stores = useStores();
  const billable = order.lines.filter((line) => openQuantity(line) > 0);
  const storeIds = [...new Set(billable.map((line) => line.fulfilStoreId))];
  const [storeId, setStoreId] = useState(String(storeIds[0]));
  const [typed, setTyped] = useState<Record<string, string>>(() =>
    Object.fromEntries(billable.map((line) => [line.id, String(openQuantity(line))])),
  );
  const [draftId, setDraftId] = useState<string | null>(null);
  const [keys] = useState(() => ({ bill: crypto.randomUUID(), issue: crypto.randomUUID() }));
  const atStore = billable.filter((line) => line.fulfilStoreId === storeId);
  const storeName = (id: string) =>
    stores.data?.find((store) => store.id === id)?.name ?? t('orders.bill.store');

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('orders.bill.title', { number: order.number })}
      description={t('orders.bill.description')}
      submitLabel={t('orders.bill.submit')}
      onSubmit={async () => {
        const lines: { orderLineId: string; quantity: number }[] = [];
        for (const line of atStore) {
          const text = String(typed[line.id]).trim();
          if (text === '' || text === '0') continue;
          const quantity = parsePositiveQuantity(text);
          if (quantity === null || quantity > openQuantity(line)) {
            return t('orders.bill.quantityInvalid', { item: line.description });
          }
          lines.push({ orderLineId: line.id, quantity });
        }
        if (lines.length === 0) return t('orders.bill.nothing');
        // A retry after a failed issue issues the draft already made.
        const id = draftId ?? (await api.orders.bill(order.id, { storeId, lines }, keys.bill)).id;
        setDraftId(id);
        await api.orders.issue(
          id,
          order.paymentTerms === 'postpaid' ? {} : { allocateAdvances: true },
          keys.issue,
        );
        // The invoice opens at once; the order's figures refresh behind it rather than
        // holding the move to the invoice until every query on this page has refetched.
        void navigate(`/invoices/${id}`);
        await refreshOrder(queryClient, order);
        return undefined;
      }}
    >
      {storeIds.length > 1 && (
        <Field label={t('orders.bill.from')}>
          <Select
            value={storeId}
            disabled={draftId !== null}
            onChange={(event) => {
              setStoreId(event.target.value);
            }}
          >
            {storeIds.map((id) => (
              <option key={id} value={id}>
                {storeName(id)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {atStore.map((line) => (
        <Field
          key={line.id}
          label={line.description}
          hint={t('orders.bill.open', { open: number(openQuantity(line)) })}
        >
          <Input
            inputMode="decimal"
            disabled={draftId !== null}
            value={typed[line.id]}
            onChange={(event) => {
              setTyped({ ...typed, [line.id]: event.target.value });
            }}
          />
        </Field>
      ))}
      {order.paymentTerms !== 'postpaid' && <p className="muted">{t('orders.bill.advances')}</p>}
    </FormDialog>
  );
}

/** Issues a draft invoice raised from the order earlier (when its issue failed). */
export function IssueDialog({
  order,
  invoiceId,
  onClose,
}: {
  readonly order: SalesOrderView;
  readonly invoiceId: string;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, money } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [key] = useState(() => crypto.randomUUID());
  const draft = useQuery({
    queryKey: ['invoices', invoiceId],
    queryFn: ({ signal }) => api.sales.invoice(invoiceId, signal),
  });
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('orders.issue.title')}
      description={
        draft.data === undefined
          ? undefined
          : t('orders.issue.description', { total: money(draft.data.totalPaise) })
      }
      submitLabel={t('orders.issue.submit')}
      onSubmit={async () => {
        await api.orders.issue(
          invoiceId,
          order.paymentTerms === 'postpaid' ? {} : { allocateAdvances: true },
          key,
        );
        // The invoice opens at once; the order's figures refresh behind it rather than
        // holding the move to the invoice until every query on this page has refetched.
        void navigate(`/invoices/${invoiceId}`);
        await refreshOrder(queryClient, order);
        return undefined;
      }}
    >
      {order.paymentTerms !== 'postpaid' && <p className="muted">{t('orders.bill.advances')}</p>}
    </FormDialog>
  );
}
