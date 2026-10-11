import {
  EWAY_BILL_NO_PATTERN,
  VEHICLE_NO_MAX_LENGTH,
  ewayBillRequired,
  type InvoiceDispatchesView,
  type TaxDocumentView,
} from '@paint/shared';
import { Button, Card, Field, Input, Table, Textarea } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { QueryState } from '../lib/QueryState.js';
import { parsePositiveQuantity } from '../lib/quantity.js';
import { usePageLanding } from '../sales/focus-landing.js';

/** The consignment value with tax of `quantity` of an invoice line, pro rata. */
export function dispatchValuePaise(
  invoice: TaxDocumentView,
  lines: readonly { readonly invoiceLineId: string; readonly quantity: number }[],
): number {
  return lines.reduce((sum, { invoiceLineId, quantity }) => {
    const line = invoice.lines.find((candidate) => candidate.id === invoiceLineId);
    return line === undefined
      ? sum
      : sum + Math.round((line.totalPaise * quantity) / line.quantity);
  }, 0);
}

function DispatchDialog({
  invoice,
  dispatches,
  onClose,
}: {
  readonly invoice: TaxDocumentView;
  readonly dispatches: InvoiceDispatchesView;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, number, money } = useI18n();
  const queryClient = useQueryClient();
  const pending = dispatches.lines.filter((line) => line.pendingQuantity > 0);
  const [typed, setTyped] = useState<Record<string, string>>(() =>
    Object.fromEntries(pending.map((line) => [line.invoiceLineId, String(line.pendingQuantity)])),
  );
  const [vehicleNo, setVehicleNo] = useState('');
  const [ewayBillNo, setEwayBillNo] = useState('');
  const [ewayValidUntil, setEwayValidUntil] = useState('');
  const [note, setNote] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('orders.dispatch.title', { number: String(invoice.number) })}
      description={t(
        dispatches.stockPosting === 'on_dispatch'
          ? 'orders.dispatch.postsStock'
          : 'orders.dispatch.recordOnly',
      )}
      submitLabel={t('orders.dispatch.submit')}
      onSubmit={async () => {
        const lines: { invoiceLineId: string; quantity: number }[] = [];
        for (const line of pending) {
          const text = String(typed[line.invoiceLineId]).trim();
          if (text === '' || text === '0') continue;
          const quantity = parsePositiveQuantity(text);
          if (quantity === null || quantity > line.pendingQuantity) {
            return t('orders.dispatch.quantityInvalid', {
              item: line.description ?? t('common.none'),
            });
          }
          lines.push({ invoiceLineId: line.invoiceLineId, quantity });
        }
        if (lines.length === 0) return t('orders.dispatch.nothing');
        const eway = ewayBillNo.trim();
        const value = dispatchValuePaise(invoice, lines);
        if (eway === '' && ewayBillRequired(value, dispatches.ewayThresholdPaise)) {
          return t('orders.dispatch.ewayNeeded', {
            value: money(value),
            threshold: money(dispatches.ewayThresholdPaise),
          });
        }
        if (eway !== '' && !EWAY_BILL_NO_PATTERN.test(eway))
          return t('orders.dispatch.ewayInvalid');
        const vehicle = vehicleNo.trim().toUpperCase();
        const trimmed = note.trim();
        await api.orders.dispatch(
          invoice.id,
          {
            lines,
            ...(vehicle === '' ? {} : { vehicleNo: vehicle }),
            ...(eway === '' ? {} : { ewayBillNo: eway }),
            ...(ewayValidUntil === '' ? {} : { ewayValidUntil }),
            ...(trimmed === '' ? {} : { note: trimmed }),
          },
          key,
        );
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['invoices', invoice.id, 'dispatches'] }),
          queryClient.invalidateQueries({ queryKey: ['sales-orders'] }),
        ]);
        return undefined;
      }}
    >
      {pending.map((line) => (
        <Field
          key={line.invoiceLineId}
          label={line.description ?? t('common.none')}
          hint={t('orders.dispatch.pending', { quantity: number(line.pendingQuantity) })}
        >
          <Input
            inputMode="decimal"
            value={typed[line.invoiceLineId]}
            onChange={(event) => {
              setTyped({ ...typed, [line.invoiceLineId]: event.target.value });
            }}
          />
        </Field>
      ))}
      <Field label={t('orders.dispatch.vehicle')}>
        <Input
          maxLength={VEHICLE_NO_MAX_LENGTH}
          value={vehicleNo}
          onChange={(event) => {
            setVehicleNo(event.target.value);
          }}
        />
      </Field>
      <Field
        label={t('orders.dispatch.eway')}
        hint={t('orders.dispatch.ewayHint', { threshold: money(dispatches.ewayThresholdPaise) })}
      >
        <Input
          inputMode="numeric"
          maxLength={12}
          value={ewayBillNo}
          onChange={(event) => {
            setEwayBillNo(event.target.value);
          }}
        />
      </Field>
      <Field label={t('orders.dispatch.ewayValidUntil')}>
        <Input
          type="date"
          value={ewayValidUntil}
          onChange={(event) => {
            setEwayValidUntil(event.target.value);
          }}
        />
      </Field>
      <Field label={t('orders.editor.note')}>
        <Textarea
          rows={2}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

function Dispatches({
  invoice,
  view,
}: {
  readonly invoice: TaxDocumentView;
  readonly view: InvoiceDispatchesView;
}) {
  const { t, number, dateTime, money } = useI18n();
  const can = usePermissions();
  const [open, setOpen] = useState(false);
  const waiting = view.lines.some((line) => line.pendingQuantity > 0);
  // Once everything has gone, the "Dispatch" button goes with it.
  usePageLanding(!open, view);
  return (
    <Card
      title={t('orders.dispatch.card')}
      actions={
        waiting && can('billing:issue') ? (
          <Button
            size="sm"
            onClick={() => {
              setOpen(true);
            }}
          >
            {t('orders.dispatch.button')}
          </Button>
        ) : undefined
      }
    >
      <div className="stack">
        <Table label={t('orders.dispatch.lines')}>
          <thead>
            <tr>
              <th scope="col">{t('sales.lines.item')}</th>
              <th scope="col">{t('sales.lines.quantity')}</th>
              <th scope="col">{t('orders.dispatch.gone')}</th>
              <th scope="col">{t('orders.dispatch.waiting')}</th>
            </tr>
          </thead>
          <tbody>
            {view.lines.map((line) => (
              <tr key={line.invoiceLineId}>
                <th scope="row">{line.description ?? t('common.none')}</th>
                <td>{number(line.quantity)}</td>
                <td>{number(line.dispatchedQuantity)}</td>
                <td>{number(line.pendingQuantity)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        {view.dispatches.length === 0 ? (
          <p className="muted">{t('orders.dispatch.none')}</p>
        ) : (
          <ul className="record-list">
            {view.dispatches.map((dispatch) => (
              <li key={dispatch.id} className="record-list__row">
                <span className="record-list__title">{dispatch.number}</span>
                <span className="record-list__meta">
                  {[
                    dateTime(dispatch.dispatchedAt),
                    money(dispatch.valuePaise),
                    dispatch.vehicleNo,
                    dispatch.ewayBillNo === null
                      ? null
                      : t('orders.dispatch.ewayNo', { number: dispatch.ewayBillNo }),
                  ]
                    .filter((part) => part !== null)
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {open && (
        <DispatchDialog
          invoice={invoice}
          dispatches={view}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </Card>
  );
}

/** Goods out for an issued invoice (spec §4.2, §5.3): what has gone and what is waiting. */
export function DispatchPanel({ invoice }: { readonly invoice: TaxDocumentView }) {
  const api = useApi();
  const dispatches = useQuery({
    queryKey: ['invoices', invoice.id, 'dispatches'],
    queryFn: ({ signal }) => api.orders.dispatches(invoice.id, signal),
  });
  return (
    <QueryState query={dispatches} error="orders.dispatch.error">
      {(view) => <Dispatches invoice={invoice} view={view} />}
    </QueryState>
  );
}
