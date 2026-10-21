import { paiseToRupees, type IssuePaymentRequest, type PaymentModeView } from '@paint/shared';
import { Alert, Button, Dialog, Field, Input } from '@paint/ui';
import { useState, type SyntheticEvent } from 'react';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { parseRupees } from '../lib/inputs.js';
import { nextMode, settle } from './tender.js';

interface Row {
  readonly modeId: string;
  readonly text: string;
}

/** What the customer may leave owing: nothing for a walk-in, their credit for a customer. */
export interface CreditRoom {
  /** The customer's name; null for a walk-in sale. */
  readonly name: string | null;
  /** Credit left; null when this member cannot see it (the server decides on issue). */
  readonly availablePaise: number | null;
}

export interface IssuedSummary {
  readonly number: string;
  readonly changePaise: number;
  /** Prints the issued bill again, on the counter printer or A4. */
  readonly print: (format: 'thermal' | 'a4') => void;
}

const rupees = (paise: number) => paiseToRupees(paise);

/** Issues the bill with these payments (none: unpaid, or on the customer's account). */
export type Issue = (payments: IssuePaymentRequest[]) => Promise<void>;

/**
 * Taking the money (spec §5.2 step 4, §4.4): the amount is pre-filled with the
 * total in cash; pick another mode, or type a smaller amount and the rest moves
 * to a second payment (cash + UPI). Enter issues the bill.
 */
function PaymentForm({
  totalPaise,
  modes,
  registerSessionId,
  room,
  onIssue,
  error,
}: {
  readonly totalPaise: number;
  readonly modes: readonly PaymentModeView[];
  /** The store's open register session: cash is taken into it. */
  readonly registerSessionId: string | null;
  readonly room: CreditRoom;
  readonly onIssue: Issue;
  readonly error: string | null;
}) {
  const { t, money } = useI18n();
  // Leaving money on the customer's account needs billing:on_account (the API refuses it too).
  const onAccount = usePermissions()('billing:on_account');
  const [rows, setRows] = useState<Row[]>(() => [
    { modeId: String(nextMode(modes, [])), text: rupees(totalPaise) },
  ]);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const amounts = rows.map((row) => parseRupees(row.text));
  const valid = amounts.every((amount) => amount !== null && amount >= 0);
  const tenders = rows.map((row, at) => ({ modeId: row.modeId, amountPaise: Number(amounts[at]) }));
  const settled = settle(totalPaise, valid ? tenders : [], modes, registerSessionId);

  const setRow = (at: number, change: Partial<Row>) => {
    setProblem(null);
    setRows((current) => current.map((row, index) => (index === at ? { ...row, ...change } : row)));
  };

  /** A smaller amount than is left splits the bill: the rest goes to the next payment. */
  const setAmount = (at: number, text: string) => {
    setProblem(null);
    setRows((current) => {
      const next = current.map((row, index) => (index === at ? { ...row, text } : row));
      const typed = next.map((row) => parseRupees(row.text));
      const before = typed.slice(0, -1).reduce<number>((sum, amount) => sum + (amount ?? 0), 0);
      const rest = totalPaise - before;
      const last = next.length - 1;
      if (at === last && typed[at] !== null && Number(typed[at]) < rest) {
        const used = next.map((row) => row.modeId);
        return [
          ...next,
          { modeId: String(nextMode(modes, used)), text: rupees(rest - Number(typed[at])) },
        ];
      }
      if (at !== last && rest >= 0) {
        return next.map((row, index) => (index === last ? { ...row, text: rupees(rest) } : row));
      }
      return next;
    });
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (!valid) {
      setProblem(t('pos.pay.amountInvalid'));
      return;
    }
    if (settled.overpaid) {
      setProblem(t('pos.pay.overpaid'));
      return;
    }
    const short = settled.shortPaise;
    if (short > 0 && room.name === null) {
      setProblem(t('pos.pay.walkInShort'));
      return;
    }
    if (short > 0 && !onAccount) {
      setProblem(t('pos.pay.noOnAccount', { amount: money(short) }));
      return;
    }
    if (short > 0 && room.availablePaise !== null && short > room.availablePaise) {
      setProblem(t('pos.pay.creditShort', { name: String(room.name), amount: money(short) }));
      return;
    }
    setPending(true);
    await onIssue(settled.payments);
    setPending(false);
  };

  const shownProblem = problem ?? error;
  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <p className="pos-pay__due">{t('pos.pay.due', { amount: money(totalPaise) })}</p>
      {rows.map((row, at) => {
        const number = at + 1;
        return (
          <fieldset key={at} className="plain-fieldset pos-pay__row">
            <legend className="subheading">{t('pos.pay.payment', { number })}</legend>
            <div
              role="radiogroup"
              aria-label={t('pos.pay.mode', { number })}
              className="pos-pay__modes"
            >
              {modes.map((mode) => (
                <label key={mode.id} className="pos-pay__mode">
                  <input
                    type="radio"
                    name={`pos-pay-mode-${String(at)}`}
                    checked={row.modeId === mode.id}
                    onChange={() => {
                      setRow(at, { modeId: mode.id });
                    }}
                  />
                  {mode.name}
                </label>
              ))}
            </div>
            <div className="pos-pay__amount">
              <Field label={t('pos.pay.amount', { number })}>
                <Input
                  inputMode="decimal"
                  autoComplete="off"
                  // The first amount is ready to retype; Enter issues.
                  autoFocus={at === 0}
                  onFocus={(event) => {
                    event.target.select();
                  }}
                  value={row.text}
                  onChange={(event) => {
                    setAmount(at, event.target.value);
                  }}
                />
              </Field>
              {rows.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('pos.pay.remove', { number })}
                  onClick={() => {
                    setProblem(null);
                    setRows((current) => current.filter((_, index) => index !== at));
                  }}
                >
                  ×
                </Button>
              )}
            </div>
          </fieldset>
        );
      })}
      <>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setRows((current) => [
              ...current,
              {
                modeId: String(
                  nextMode(
                    modes,
                    current.map((row) => row.modeId),
                  ),
                ),
                text: rupees(settled.shortPaise),
              },
            ]);
          }}
        >
          {t('pos.pay.add')}
        </Button>
        <ul className="pos-pay__summary" aria-live="polite">
          <li>{t('pos.pay.tendered', { amount: money(settled.tenderedPaise) })}</li>
          {settled.changePaise > 0 && (
            <li className="pos-pay__change">
              {t('pos.pay.change', { amount: money(settled.changePaise) })}
            </li>
          )}
          {settled.shortPaise > 0 && (
            <li>
              {room.name === null || !onAccount
                ? t('pos.pay.short', { amount: money(settled.shortPaise) })
                : t('pos.pay.onCredit', { amount: money(settled.shortPaise), name: room.name })}
            </li>
          )}
        </ul>
      </>
      {shownProblem !== null && <Alert tone="danger">{shownProblem}</Alert>}
      <Button type="submit" loading={pending}>
        {t('pos.pay.issue')}
      </Button>
    </form>
  );
}

/** No way to pay is set up: the bill is issued without a payment. */
function IssueOnlyForm({
  totalPaise,
  onIssue,
  error,
}: {
  readonly totalPaise: number;
  readonly onIssue: Issue;
  readonly error: string | null;
}) {
  const { t, money } = useI18n();
  const [pending, setPending] = useState(false);
  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        void onIssue([]).finally(() => {
          setPending(false);
        });
      }}
    >
      <p className="pos-pay__due">{t('pos.pay.due', { amount: money(totalPaise) })}</p>
      <Alert tone="info">{t('pos.pay.notRecorded')}</Alert>
      {error !== null && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" loading={pending} autoFocus>
        {t('pos.pay.issue')}
      </Button>
    </form>
  );
}

/** The payment step, then the issued bill with its print and "New sale". */
export function PayDialog({
  open,
  onClose,
  totalPaise,
  modes,
  registerSessionId,
  room,
  onIssue,
  error,
  issued,
  onNewSale,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly totalPaise: number;
  readonly modes: readonly PaymentModeView[];
  readonly registerSessionId: string | null;
  readonly room: CreditRoom;
  readonly onIssue: Issue;
  readonly error: string | null;
  readonly issued: IssuedSummary | null;
  readonly onNewSale: () => void;
}) {
  const { t, money } = useI18n();
  return (
    <Dialog
      open={open}
      // Controlled with no trigger: it only ever asks to close.
      onOpenChange={() => {
        if (issued === null) onClose();
        else onNewSale();
      }}
      title={issued === null ? t('pos.pay.title') : t('pos.pay.issued', { number: issued.number })}
      closeLabel={t('common.close')}
    >
      {issued === null ? (
        modes.length === 0 ? (
          <IssueOnlyForm totalPaise={totalPaise} onIssue={onIssue} error={error} />
        ) : (
          <PaymentForm
            totalPaise={totalPaise}
            modes={modes}
            registerSessionId={registerSessionId}
            room={room}
            onIssue={onIssue}
            error={error}
          />
        )
      ) : (
        <div className="stack">
          {issued.changePaise > 0 && (
            <p className="pos-pay__change" role="status">
              {t('pos.pay.change', { amount: money(issued.changePaise) })}
            </p>
          )}
          <div className="row">
            <Button
              variant="secondary"
              onClick={() => {
                issued.print('thermal');
              }}
            >
              {t('pos.pay.print')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                issued.print('a4');
              }}
            >
              {t('pos.pay.printA4')}
            </Button>
          </div>
          <Button autoFocus onClick={onNewSale}>
            {t('pos.pay.newSale')}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
