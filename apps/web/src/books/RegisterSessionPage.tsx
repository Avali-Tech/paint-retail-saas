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
  useToast,
} from '@paint/ui';
import {
  CASH_DENOMINATIONS_PAISE,
  REGISTER_MOVEMENT_KINDS,
  countedCash,
  type RegisterMovementKind,
  type RegisterSessionView,
} from '@paint/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { parseRupees } from '../lib/inputs.js';
import { QueryState } from '../lib/QueryState.js';
import { VARIANCE_TONE, readCounts, varianceKind, type CountTexts } from './day-end.js';
import { VarianceBadge, ZReport } from './ZReport.js';

const sessionKey = (id: string) => ['register-sessions', 'one', id] as const;

/** Puts the answer in place of the session and refreshes the store's list. */
function useSessionSaved() {
  const queryClient = useQueryClient();
  return async (session: RegisterSessionView) => {
    queryClient.setQueryData(sessionKey(session.id), session);
    await queryClient.invalidateQueries({ queryKey: ['register-sessions', session.storeId] });
  };
}

/** Float, cash in and out, and what the drawer should hold now. */
function Summary({ session }: { readonly session: RegisterSessionView }) {
  const { t, money, dateTime } = useI18n();
  const moved = session.movements.reduce(
    (sum, movement) => sum + (movement.kind === 'pay_in' ? 1 : -1) * movement.amountPaise,
    0,
  );
  const facts: [string, string][] = [
    [t('books.session.openedBy'), session.openedBy],
    [t('books.session.openedAt'), dateTime(session.openedAt)],
    [t('books.session.float'), money(session.openingFloatPaise)],
    [t('books.session.cashIn'), money(session.cashInPaise)],
    [t('books.session.cashOut'), money(session.cashOutPaise)],
    [t('books.session.moved'), money(moved)],
    [t('books.session.expected'), money(session.expectedCashPaise)],
  ];
  return (
    <Card title={t('books.session.summary')}>
      <dl className="facts">
        {facts.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** UPI, card, cheque and cash taken in the session, for the day's other totals. */
function ModeTotals({ session }: { readonly session: RegisterSessionView }) {
  const { t, money } = useI18n();
  return (
    <Card title={t('books.session.modes')}>
      {session.modeTotals.length === 0 ? (
        <p className="muted">{t('books.session.noPayments')}</p>
      ) : (
        <Table label={t('books.session.modes')}>
          <thead>
            <tr>
              <th scope="col">{t('books.session.mode')}</th>
              <th scope="col">{t('books.session.in')}</th>
              <th scope="col">{t('books.session.out')}</th>
              <th scope="col">{t('books.session.count')}</th>
            </tr>
          </thead>
          <tbody>
            {session.modeTotals.map((mode) => (
              <tr key={mode.modeId}>
                <th scope="row">{mode.name}</th>
                <td>{money(mode.inPaise)}</td>
                <td>{money(mode.outPaise)}</td>
                <td>{mode.count}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/** Pay-ins, pay-outs and bank deposits, and a form for another while the session is open. */
function Movements({ session }: { readonly session: RegisterSessionView }) {
  const api = useApi();
  const { t, label, money, dateTime } = useI18n();
  const toast = useToast();
  const saved = useSessionSaved();
  const [kind, setKind] = useState<RegisterMovementKind>('pay_out');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ amount?: string; reason?: string }>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const amountPaise = parseRupees(amount);
    const problems = {
      ...(amountPaise === null || amountPaise <= 0
        ? { amount: t('books.session.amountInvalid') }
        : {}),
      ...(reason.trim() === '' ? { reason: t('books.session.reasonRequired') } : {}),
    };
    setErrors(problems);
    setMessage(null);
    if (amountPaise === null || Object.keys(problems).length > 0) return;
    setPending(true);
    try {
      await saved(
        await api.books.moveCash(session.id, { kind, amountPaise, reason: reason.trim() }),
      );
      setAmount('');
      setReason('');
      toast({ title: t('books.session.recorded'), tone: 'success' });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card title={t('books.session.movements')}>
      <div className="stack">
        {session.movements.length === 0 ? (
          <p className="muted">{t('books.session.noMovements')}</p>
        ) : (
          <Table label={t('books.session.movements')}>
            <thead>
              <tr>
                <th scope="col">{t('books.session.kind')}</th>
                <th scope="col">{t('books.session.amount')}</th>
                <th scope="col">{t('books.session.reason')}</th>
                <th scope="col">{t('books.session.at')}</th>
              </tr>
            </thead>
            <tbody>
              {session.movements.map((movement) => (
                <tr key={movement.id}>
                  <th scope="row">{label('registerMovements', movement.kind)}</th>
                  <td>{money(movement.amountPaise)}</td>
                  <td>{movement.reason}</td>
                  <td>{dateTime(movement.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {session.status === 'open' && (
          <form
            className="stack"
            noValidate
            aria-label={t('books.session.addMovement')}
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            {message !== null && <Alert tone="danger">{message}</Alert>}
            <div className="form-grid">
              <Field label={t('books.session.kind')}>
                <Select
                  value={kind}
                  onChange={(event) => {
                    setKind(event.target.value as RegisterMovementKind);
                  }}
                >
                  {REGISTER_MOVEMENT_KINDS.map((value) => (
                    <option key={value} value={value}>
                      {label('registerMovements', value)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('books.session.amount')} error={errors.amount}>
                <Input
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value);
                  }}
                />
              </Field>
              <Field label={t('books.session.reason')} error={errors.reason}>
                <Input
                  value={reason}
                  maxLength={200}
                  onChange={(event) => {
                    setReason(event.target.value);
                  }}
                />
              </Field>
            </div>
            <div className="row row--end">
              <Button type="submit" variant="secondary" loading={pending}>
                {t('books.session.addMovement')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

/** The count by denomination, with counted, expected and the variance as it is typed. */
function CloseRegister({ session }: { readonly session: RegisterSessionView }) {
  const api = useApi();
  const { t, money } = useI18n();
  const toast = useToast();
  const saved = useSessionSaved();
  const [texts, setTexts] = useState<CountTexts>({});
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { counts, invalid } = readCounts(texts);
  const counted = countedCash(counts);
  const variance = counted - session.expectedCashPaise;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setMessage(null);
    if (invalid.length > 0) return;
    setPending(true);
    try {
      await saved(
        await api.books.closeRegister(session.id, {
          denominations: counts,
          countedCashPaise: counted,
          ...(note.trim() === '' ? {} : { note: note.trim() }),
        }),
      );
      toast({ title: t('books.session.closed'), tone: 'success' });
    } catch (error) {
      setMessage(errorMessage(error));
      setPending(false);
    }
  };

  return (
    <Card title={t('books.session.closeTitle')}>
      <form
        className="stack"
        noValidate
        aria-label={t('books.session.closeTitle')}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {message !== null && <Alert tone="danger">{message}</Alert>}
        <fieldset className="denominations">
          <legend>{t('books.session.denominations')}</legend>
          {CASH_DENOMINATIONS_PAISE.map((value) => {
            const key = String(value);
            return (
              <Field
                key={key}
                label={money(value)}
                error={invalid.includes(key) ? t('books.session.countInvalid') : undefined}
              >
                <Input
                  inputMode="numeric"
                  aria-label={t('books.session.countOf', { value: money(value) })}
                  value={texts[key] ?? ''}
                  onChange={(event) => {
                    setTexts({ ...texts, [key]: event.target.value });
                  }}
                />
              </Field>
            );
          })}
        </fieldset>
        <dl className="facts" aria-label={t('books.session.countSummary')}>
          <div>
            <dt>{t('books.session.counted')}</dt>
            <dd>{money(counted)}</dd>
          </div>
          <div>
            <dt>{t('books.session.expected')}</dt>
            <dd>{money(session.expectedCashPaise)}</dd>
          </div>
          <div>
            <dt>{t('books.session.variance')}</dt>
            <dd>
              <VarianceBadge variancePaise={variance} />
            </dd>
          </div>
        </dl>
        <Field label={t('books.session.closeNote')}>
          <Input
            value={note}
            maxLength={300}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </Field>
        <div className="row row--end">
          <Button type="submit" loading={pending}>
            {t('books.session.close')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SessionDetail({ session }: { readonly session: RegisterSessionView }) {
  const { t, label } = useI18n();
  return (
    <>
      <PageHeader
        title={t('books.session.title', { code: session.registerCode })}
        actions={
          <Badge tone={session.status === 'open' ? 'success' : 'neutral'}>
            {label('registerStatuses', session.status)}
          </Badge>
        }
      />
      <div className="stack">
        {session.variancePaise !== null && (
          <Alert tone={VARIANCE_TONE[varianceKind(session.variancePaise)]}>
            <VarianceBadge variancePaise={session.variancePaise} />
          </Alert>
        )}
        <Summary session={session} />
        <ModeTotals session={session} />
        <Movements session={session} />
        {session.status === 'open' ? (
          <CloseRegister session={session} />
        ) : (
          <ZReport session={session} />
        )}
      </div>
    </>
  );
}

/** /registers/:id — one register session: cash, movements, the count at close and the Z-report. */
export function RegisterSessionPage() {
  const api = useApi();
  // The route always has an :id.
  const id = String(useParams().id);
  const session = useQuery({
    queryKey: sessionKey(id),
    queryFn: ({ signal }) => api.books.register(id, signal),
  });
  return (
    <QueryState query={session} error="books.session.error">
      {(data) => <SessionDetail session={data} />}
    </QueryState>
  );
}
