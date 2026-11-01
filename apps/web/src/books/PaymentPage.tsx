import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Table,
  Textarea,
  buttonStyle,
  useToast,
} from '@paint/ui';
import type { AllocationView, PaymentModeView, PaymentView } from '@paint/shared';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { errorMessage, errorWithIssues } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { saveFile } from '../lib/download.js';
import { FormDialog } from '../lib/FormDialog.js';
import { todayInIndia } from '../lib/india-time.js';
import { parseRupees, rupeesInput } from '../lib/inputs.js';
import { QueryState } from '../lib/QueryState.js';
import { checkAllocations, oldestFirst, type AllocationTexts } from './allocation.js';
import { AllocationTable } from './AllocationTable.js';
import { usePaymentModes } from './TakePaymentPage.js';

/** What a payment still allows, as the API decides it (payments.service.ts). */
export function paymentActions(payment: PaymentView) {
  const received = payment.direction === 'in' && payment.chequeStatus !== 'bounced';
  return {
    allocate: received && payment.unallocatedPaise > 0,
    cheque: payment.chequeStatus === 'pending',
    refund: received && payment.chequeStatus !== 'pending' && payment.unallocatedPaise > 0,
  };
}

/** A live allocation to a bill that can be undone: not a refund, not undone already. */
const undoable = (row: AllocationView) =>
  row.amountPaise > 0 && row.refundPaymentId === null && row.creditNoteId === null && !row.reversed;

/** Everything that shows the payment, the customer's account or their bills again. */
async function refresh(queryClient: QueryClient, payment: PaymentView) {
  await queryClient.invalidateQueries({ queryKey: ['payments'] });
  await queryClient.invalidateQueries({ queryKey: ['party-ledger', payment.partyId] });
  await queryClient.invalidateQueries({ queryKey: ['invoices'] });
}

/** Turns a failed call into the dialog's message, field problems included. */
async function attempt(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return errorWithIssues(error);
  }
}

/** "Allocate": what the payment has not allocated, against the customer's open bills. */
function AllocateDialog({
  payment,
  onClose,
  onDone,
}: {
  readonly payment: PaymentView;
  readonly onClose: () => void;
  readonly onDone: (next: PaymentView) => Promise<void>;
}) {
  const api = useApi();
  const { t, money } = useI18n();
  const ledger = useQuery({
    queryKey: ['party-ledger', payment.partyId, 'open'],
    queryFn: ({ signal }) => api.parties.ledger(payment.partyId, { limit: 1, offset: 0 }, signal),
  });
  const bills = ledger.data?.openDocuments ?? [];
  const [edited, setEdited] = useState<AllocationTexts | null>(null);
  const texts = edited ?? oldestFirst(bills, payment.unallocatedPaise);
  const check = checkAllocations(bills, texts, payment.unallocatedPaise);
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('books.payment.allocateTitle', { number: payment.number })}
      description={t('books.payment.allocateHint', { amount: money(payment.unallocatedPaise) })}
      submitLabel={t('books.payment.allocate')}
      onSubmit={() => {
        if (!check.ok) return false;
        if (check.allocations.length === 0) return t('books.payment.allocateNothing');
        return attempt(async () => {
          await onDone(await api.books.allocate(payment.id, check.allocations));
        });
      }}
    >
      <QueryState query={ledger} error="books.allocate.error">
        {() => (
          <AllocationTable
            bills={bills}
            availablePaise={payment.unallocatedPaise}
            texts={texts}
            onChange={setEdited}
            check={check}
          />
        )}
      </QueryState>
    </FormDialog>
  );
}

/** "Cheque cleared": the bank credited it, on a day from receipt to today. */
function ClearDialog({
  payment,
  onClose,
  onDone,
}: {
  readonly payment: PaymentView;
  readonly onClose: () => void;
  readonly onDone: (next: PaymentView) => Promise<void>;
}) {
  const api = useApi();
  const { t } = useI18n();
  const [today] = useState(todayInIndia);
  const [clearedOn, setClearedOn] = useState(today);
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('books.payment.clearTitle', { reference: String(payment.reference) })}
      submitLabel={t('books.payment.clear')}
      onSubmit={() =>
        attempt(async () => {
          await onDone(
            await api.books.clearCheque(payment.id, clearedOn === '' ? {} : { clearedOn }),
          );
        })
      }
    >
      <Field label={t('books.payment.clearedOn')}>
        <Input
          type="date"
          min={payment.receivedOn}
          max={today}
          value={clearedOn}
          onChange={(event) => {
            setClearedOn(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

/** "Cheque bounced": its bills are owed again, with a charge when the shop levies one. */
function BounceDialog({
  payment,
  onClose,
  onDone,
}: {
  readonly payment: PaymentView;
  readonly onClose: () => void;
  readonly onDone: (next: PaymentView) => Promise<void>;
}) {
  const api = useApi();
  const { t, money } = useI18n();
  const [today] = useState(todayInIndia);
  const [bouncedOn, setBouncedOn] = useState(today);
  const [reason, setReason] = useState('');
  const [charge, setCharge] = useState('');
  const [errors, setErrors] = useState<{ reason?: string; charge?: string }>({});
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('books.payment.bounceTitle', { reference: String(payment.reference) })}
      description={t('books.payment.bounceHint', { amount: money(payment.amountPaise) })}
      submitLabel={t('books.payment.bounce')}
      onSubmit={() => {
        const typed = charge.trim() !== '';
        const chargePaise = typed ? parseRupees(charge) : null;
        const badCharge = typed && (chargePaise === null || chargePaise <= 0);
        const problems = {
          ...(reason.trim() === '' ? { reason: t('books.payment.reasonRequired') } : {}),
          ...(badCharge ? { charge: t('books.payment.chargeInvalid') } : {}),
        };
        setErrors(problems);
        if (Object.keys(problems).length > 0) return false;
        return attempt(async () => {
          await onDone(
            await api.books.bounceCheque(payment.id, {
              bouncedOn,
              reason: reason.trim(),
              ...(chargePaise === null ? {} : { chargePaise }),
            }),
          );
        });
      }}
    >
      <Field label={t('books.payment.bouncedOn')}>
        <Input
          type="date"
          min={payment.receivedOn}
          max={today}
          value={bouncedOn}
          onChange={(event) => {
            setBouncedOn(event.target.value);
          }}
        />
      </Field>
      <Field label={t('books.payment.reason')} error={errors.reason} required>
        <Textarea
          maxLength={500}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
      <Field
        label={t('books.payment.charge')}
        hint={t('books.payment.chargeHint')}
        error={errors.charge}
      >
        <Input
          inputMode="decimal"
          value={charge}
          onChange={(event) => {
            setCharge(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

/** "Refund": pays back what the payment has not allocated (an advance), by any mode. */
function RefundDialog({
  payment,
  modes,
  onClose,
}: {
  readonly payment: PaymentView;
  readonly modes: readonly [PaymentModeView, ...PaymentModeView[]];
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [today] = useState(todayInIndia);
  const [key] = useState(() => crypto.randomUUID());
  const [mode, setMode] = useState(
    modes.find((option) => option.id === payment.mode.id) ?? modes[0],
  );
  const [amount, setAmount] = useState(rupeesInput(payment.unallocatedPaise));
  const [paidOn, setPaidOn] = useState(today);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('books.payment.refundTitle', { number: payment.number })}
      description={t('books.payment.refundHint')}
      submitLabel={t('books.payment.refund')}
      onSubmit={async () => {
        const amountPaise = parseRupees(amount);
        if (amountPaise === null || amountPaise <= 0 || amountPaise > payment.unallocatedPaise) {
          setError(t('books.payment.refundInvalid'));
          return false;
        }
        setError(undefined);
        const problem = await attempt(async () => {
          const refund = await api.books.refund(
            payment.id,
            {
              modeId: mode.id,
              amountPaise,
              paidOn,
              ...(reference.trim() === '' ? {} : { reference: reference.trim() }),
              ...(note.trim() === '' ? {} : { note: note.trim() }),
            },
            key,
          );
          await refresh(queryClient, payment);
          toast({ title: t('books.payment.refunded', { number: refund.number }), tone: 'success' });
          void navigate(`/payments/${refund.id}`);
        });
        return problem;
      }}
    >
      <Field label={t('books.payment.refundAmount')} error={error} required>
        <Input
          inputMode="decimal"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
          }}
        />
      </Field>
      <Field label={t('books.take.mode')}>
        <Select
          value={mode.id}
          onChange={(event) => {
            const id = event.target.value;
            setMode(...(modes.filter((option) => option.id === id) as [PaymentModeView]));
          }}
        >
          {modes.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('books.payment.paidOn')}>
        <Input
          type="date"
          min={payment.receivedOn}
          max={today}
          value={paidOn}
          onChange={(event) => {
            setPaidOn(event.target.value);
          }}
        />
      </Field>
      <Field label={t('books.take.reference')}>
        <Input
          maxLength={100}
          value={reference}
          onChange={(event) => {
            setReference(event.target.value);
          }}
        />
      </Field>
      <Field label={t('books.take.note')}>
        <Textarea
          maxLength={500}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

/** "Undo" on one allocation: the money becomes an advance again. */
function UndoDialog({
  payment,
  row,
  onClose,
  onDone,
}: {
  readonly payment: PaymentView;
  readonly row: AllocationView;
  readonly onClose: () => void;
  readonly onDone: (next: PaymentView) => Promise<void>;
}) {
  const api = useApi();
  const { t, money } = useI18n();
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('books.payment.undoTitle', {
        amount: money(row.amountPaise),
        bill: String(row.targetNumber),
      })}
      description={t('books.payment.undoHint')}
      submitLabel={t('books.payment.undo')}
      onSubmit={() =>
        attempt(async () => {
          await onDone(await api.books.reverseAllocation(payment.id, row.id));
        })
      }
    >
      {null}
    </FormDialog>
  );
}

/** Downloads the receipt or refund slip as a PDF. */
function ReceiptPdf({ payment }: { readonly payment: PaymentView }) {
  const api = useApi();
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="secondary"
        loading={pending}
        onClick={() => {
          setPending(true);
          setMessage(null);
          api.books
            .receiptPdf(payment.id)
            .then((file) => {
              saveFile(file.blob, file.fileName ?? `${payment.number}.pdf`);
            })
            .catch((error: unknown) => {
              setMessage(errorMessage(error));
            })
            .finally(() => {
              setPending(false);
            });
        }}
      >
        {t('books.payment.receiptPdf')}
      </Button>
      {message !== null && <Alert tone="danger">{message}</Alert>}
    </>
  );
}

type Open =
  | { readonly kind: 'allocate' | 'clear' | 'bounce' | 'refund' }
  | { readonly kind: 'undo'; readonly row: AllocationView }
  | null;

function Allocations({
  payment,
  onUndo,
}: {
  readonly payment: PaymentView;
  readonly onUndo: ((row: AllocationView) => void) | null;
}) {
  const { t, label, money, dateTime } = useI18n();
  if (payment.allocations.length === 0) {
    return <p className="muted">{t('books.payment.noAllocations')}</p>;
  }
  return (
    <Table label={t('books.payment.allocations')}>
      <thead>
        <tr>
          <th scope="col">{t('books.payment.against')}</th>
          <th scope="col" className="numeric">
            {t('books.payment.amount')}
          </th>
          <th scope="col">{t('books.payment.when')}</th>
          {onUndo !== null && <th scope="col">{t('books.payment.actions')}</th>}
        </tr>
      </thead>
      <tbody>
        {payment.allocations.map((row) => {
          const name = row.targetNumber ?? t('common.none');
          return (
            <tr key={row.id}>
              <th scope="row">
                {row.documentId === null ? (
                  name
                ) : (
                  <Link to={`/invoices/${row.documentId}`}>{name}</Link>
                )}
                <span className="cell-meta">
                  {row.refundPaymentId !== null
                    ? t('books.payment.refundRow')
                    : row.reversalReason !== null
                      ? label('allocationReversals', row.reversalReason)
                      : row.reversed
                        ? t('books.payment.undone')
                        : ''}
                </span>
              </th>
              <td className="numeric">{money(row.amountPaise)}</td>
              <td>{dateTime(row.createdAt)}</td>
              {onUndo !== null && (
                <td>
                  {undoable(row) && (
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={t('books.payment.undoOf', { bill: name })}
                      onClick={() => {
                        onUndo(row);
                      }}
                    >
                      {t('books.payment.undo')}
                    </Button>
                  )}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function PaymentDetail({ payment }: { readonly payment: PaymentView }) {
  const { t, label, money, date } = useI18n();
  const can = usePermissions();
  const toast = useToast();
  const queryClient = useQueryClient();
  const modes = usePaymentModes();
  const [open, setOpen] = useState<Open>(null);
  const manage = can('payments:manage');
  const actions = paymentActions(payment);
  const received = payment.direction === 'in';
  const close = () => {
    setOpen(null);
  };
  const done = async (next: PaymentView) => {
    queryClient.setQueryData(['payments', next.id], next);
    await refresh(queryClient, next);
    toast({ title: t('books.payment.saved'), tone: 'success' });
  };
  const facts: [string, string][] = [
    [t('books.payment.date'), date(payment.receivedOn)],
    [t('books.payment.mode'), payment.mode.name],
    [t('books.payment.amount'), money(payment.amountPaise)],
  ];
  if (payment.voucherNumber !== null) {
    facts.push([t('books.payment.voucher'), payment.voucherNumber]);
  }
  if (payment.reference !== null) facts.push([t('books.payment.reference'), payment.reference]);
  if (payment.chequeDate !== null) {
    facts.push([t('books.payment.chequeDate'), date(payment.chequeDate)]);
  }
  if (payment.chequeClearedOn !== null) {
    facts.push([t('books.payment.clearedOn'), date(payment.chequeClearedOn)]);
  }
  if (payment.chequeBouncedOn !== null) {
    facts.push([
      t('books.payment.bouncedOn'),
      `${date(payment.chequeBouncedOn)} · ${String(payment.bounceReason)}`,
    ]);
  }
  if (received) facts.push([t('books.payment.advance'), money(payment.unallocatedPaise)]);
  if (payment.note !== null) facts.push([t('books.payment.note'), payment.note]);
  const modeList = modes.data ?? [];
  const [firstMode, ...otherModes] = modeList;
  return (
    <>
      <PageHeader
        title={t(received ? 'books.payment.title' : 'books.payment.refundOf', {
          number: payment.number,
        })}
        description={payment.partyName}
        actions={
          <span className="row">
            <ReceiptPdf payment={payment} />
            <Link to={`/parties/${payment.partyId}/ledger`} {...buttonStyle('secondary')}>
              {t('books.payment.account')}
            </Link>
          </span>
        }
      />
      <Card
        title={t('books.payment.details')}
        actions={
          <span className="row">
            <Badge tone={received ? 'success' : 'neutral'}>
              {label('paymentDirections', payment.direction)}
            </Badge>
            {payment.chequeStatus !== null && (
              <Badge tone={payment.chequeStatus === 'bounced' ? 'danger' : 'info'}>
                {label('chequeStatuses', payment.chequeStatus)}
              </Badge>
            )}
          </span>
        }
      >
        <div className="stack">
          <dl className="facts">
            {facts.map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {manage && (actions.allocate || actions.cheque || actions.refund) && (
            <div className="row">
              {actions.allocate && (
                <Button
                  onClick={() => {
                    setOpen({ kind: 'allocate' });
                  }}
                >
                  {t('books.payment.allocate')}
                </Button>
              )}
              {actions.cheque && (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setOpen({ kind: 'clear' });
                    }}
                  >
                    {t('books.payment.clear')}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      setOpen({ kind: 'bounce' });
                    }}
                  >
                    {t('books.payment.bounce')}
                  </Button>
                </>
              )}
              {actions.refund && firstMode !== undefined && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setOpen({ kind: 'refund' });
                  }}
                >
                  {t('books.payment.refund')}
                </Button>
              )}
            </div>
          )}
          {payment.chequeStatus === 'pending' && received && (
            <Alert tone="info">{t('books.payment.pendingHint')}</Alert>
          )}
        </div>
      </Card>
      <Card title={t('books.payment.allocations')}>
        <Allocations
          payment={payment}
          onUndo={
            manage && payment.chequeStatus !== 'bounced'
              ? (row) => {
                  setOpen({ kind: 'undo', row });
                }
              : null
          }
        />
      </Card>
      {open?.kind === 'allocate' && (
        <AllocateDialog payment={payment} onClose={close} onDone={done} />
      )}
      {open?.kind === 'clear' && <ClearDialog payment={payment} onClose={close} onDone={done} />}
      {open?.kind === 'bounce' && <BounceDialog payment={payment} onClose={close} onDone={done} />}
      {open?.kind === 'refund' && firstMode !== undefined && (
        <RefundDialog payment={payment} modes={[firstMode, ...otherModes]} onClose={close} />
      )}
      {open?.kind === 'undo' && (
        <UndoDialog payment={payment} row={open.row} onClose={close} onDone={done} />
      )}
    </>
  );
}

/** /payments/:id — one payment or refund: its bills, cheque, refunds and receipt. */
export function PaymentPage() {
  const api = useApi();
  // The route always has an :id.
  const id = String(useParams().id);
  const payment = useQuery({
    queryKey: ['payments', id],
    queryFn: ({ signal }) => api.books.payment(id, signal),
  });
  return (
    <QueryState query={payment} error="books.payment.error">
      {(data) => <PaymentDetail payment={data} />}
    </QueryState>
  );
}
