import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  buttonStyle,
  useToast,
} from '@paint/ui';
import type { PaymentModeView, RecordPaymentRequest } from '@paint/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { errorWithIssues } from '../api/errors.js';
import type { Party } from '../api/parties.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { todayInIndia } from '../lib/india-time.js';
import { parseRupees } from '../lib/inputs.js';
import { QueryState } from '../lib/QueryState.js';
import { PartyPicker } from '../parties/PartyPicker.js';
import { StoreSelect } from '../stock/StoreSelect.js';
import { useStores } from '../stock/stores.js';
import { checkAllocations, oldestFirst, type AllocationTexts } from './allocation.js';
import { AllocationTable } from './AllocationTable.js';

/** The ways a member may take money by hand: active, and not a payment link (the gateway's). */
export const takeableModes = (modes: readonly PaymentModeView[]) =>
  modes.filter((mode) => mode.isActive && mode.kind !== 'upi_link');

/** The ways to pay, for a payment form. */
export function usePaymentModes() {
  const api = useApi();
  return useQuery({
    queryKey: ['payment-modes', 'takeable'],
    queryFn: async ({ signal }) => takeableModes(await api.books.paymentModes(signal)),
  });
}

interface Errors {
  store?: string;
  amount?: string;
  reference?: string;
  chequeDate?: string;
  receivedOn?: string;
}

/** The payment and how it is put against the customer's bills. */
function PaymentForm({
  party,
  modes,
}: {
  readonly party: Party;
  readonly modes: readonly [PaymentModeView, ...PaymentModeView[]];
}) {
  const api = useApi();
  const { t, money } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const can = usePermissions();
  const stores = useStores();
  const [only, ...others] = (stores.data ?? []).filter((store) => store.isActive);
  const [today] = useState(todayInIndia);
  const [key] = useState(() => crypto.randomUUID());
  const [storeId, setStoreId] = useState('');
  const [mode, setMode] = useState(modes[0]);
  const [amount, setAmount] = useState('');
  const [receivedOn, setReceivedOn] = useState(today);
  const [reference, setReference] = useState('');
  const [chequeDate, setChequeDate] = useState('');
  const [note, setNote] = useState('');
  // Filled oldest first until the member changes an amount by hand.
  const [edited, setEdited] = useState<AllocationTexts | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const ledger = useQuery({
    queryKey: ['party-ledger', party.id, 'open'],
    queryFn: ({ signal }) => api.parties.ledger(party.id, { limit: 1, offset: 0 }, signal),
  });
  const bills = ledger.data?.openDocuments ?? [];
  // A member of one store takes money there without choosing it.
  const store = storeId === '' && only !== undefined && others.length === 0 ? only.id : storeId;
  const cheque = mode.kind === 'cheque';
  const amountPaise = parseRupees(amount);
  const available = amountPaise !== null && amountPaise > 0 ? amountPaise : 0;
  const texts = edited ?? oldestFirst(bills, available);
  const check = checkAllocations(bills, texts, available);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const problems: Errors = {
      ...(store === '' ? { store: t('books.take.storeRequired') } : {}),
      ...(available === 0 ? { amount: t('books.take.amountInvalid') } : {}),
      ...(receivedOn === '' || receivedOn > today
        ? { receivedOn: t('books.take.dateInvalid') }
        : {}),
      ...(cheque && reference.trim() === ''
        ? { reference: t('books.take.chequeNumberRequired') }
        : {}),
      ...(cheque && chequeDate === '' ? { chequeDate: t('books.take.chequeDateRequired') } : {}),
    };
    setErrors(problems);
    setMessage(null);
    if (Object.keys(problems).length > 0 || !check.ok) return;
    const input: RecordPaymentRequest = {
      storeId: store,
      partyId: party.id,
      modeId: mode.id,
      amountPaise: available,
      receivedOn,
      ...(reference.trim() === '' ? {} : { reference: reference.trim() }),
      ...(cheque ? { chequeDate } : {}),
      ...(note.trim() === '' ? {} : { note: note.trim() }),
      allocations: check.allocations,
    };
    setPending(true);
    try {
      const payment = await api.books.recordPayment(input, key);
      await queryClient.invalidateQueries({ queryKey: ['payments'] });
      await queryClient.invalidateQueries({ queryKey: ['party-ledger', party.id] });
      toast({ title: t('books.take.done', { number: payment.number }), tone: 'success' });
      void navigate(`/payments/${payment.id}`);
    } catch (error) {
      setMessage(errorWithIssues(error));
      setPending(false);
    }
  };

  return (
    <form
      className="stack"
      noValidate
      aria-label={t('books.take.form')}
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <Card title={t('books.take.payment')}>
        <div className="stack">
          <div className="filters">
            <StoreSelect
              label={t('books.take.store')}
              value={store}
              onChange={setStoreId}
              emptyLabel={t('books.take.chooseStore')}
              error={errors.store}
              required
            />
            <Field label={t('books.take.mode')} required>
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
            <Field label={t('books.take.amount')} error={errors.amount} required>
              <Input
                inputMode="decimal"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                }}
              />
            </Field>
            <Field label={t('books.take.receivedOn')} error={errors.receivedOn} required>
              <Input
                type="date"
                max={today}
                value={receivedOn}
                onChange={(event) => {
                  setReceivedOn(event.target.value);
                }}
              />
            </Field>
          </div>
          {mode.kind === 'cash' && <p className="cell-meta">{t('books.take.cashHint')}</p>}
          <div className="filters">
            <Field
              label={cheque ? t('books.take.chequeNumber') : t('books.take.reference')}
              error={errors.reference}
              required={cheque}
            >
              <Input
                value={reference}
                maxLength={100}
                onChange={(event) => {
                  setReference(event.target.value);
                }}
              />
            </Field>
            {cheque && (
              <Field label={t('books.take.chequeDate')} error={errors.chequeDate} required>
                <Input
                  type="date"
                  value={chequeDate}
                  onChange={(event) => {
                    setChequeDate(event.target.value);
                  }}
                />
              </Field>
            )}
          </div>
          <Field label={t('books.take.note')}>
            <Textarea
              value={note}
              maxLength={500}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </Field>
        </div>
      </Card>
      <Card title={t('books.take.against')}>
        <div className="stack">
          <p className="cell-meta">{t('books.take.againstHint')}</p>
          <QueryState query={ledger} error="books.allocate.error">
            {() => (
              <AllocationTable
                bills={bills}
                availablePaise={available}
                texts={texts}
                onChange={setEdited}
                check={check}
              />
            )}
          </QueryState>
        </div>
      </Card>
      {message !== null && (
        <Alert tone="danger">
          {message}
          {mode.kind === 'cash' && can('register:manage') && (
            <>
              {' '}
              <Link to="/registers">{t('books.take.openRegister')}</Link>
            </>
          )}
        </Alert>
      )}
      <div className="row row--end">
        <Button type="submit" loading={pending}>
          {available === 0
            ? t('books.take.submit')
            : t('books.take.submitAmount', { amount: money(available) })}
        </Button>
      </div>
    </form>
  );
}

/**
 * /payments/new — money a customer pays on account, by any mode (a cheque with its
 * number and date), put against their bills oldest first or as the member chooses;
 * the rest stays as an advance. ?partyId= starts with the customer chosen.
 */
export function TakePaymentPage() {
  const api = useApi();
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const partyId = params.get('partyId');
  const party = useQuery({
    queryKey: ['parties', partyId],
    queryFn: ({ signal }) => api.parties.get(String(partyId), signal),
    enabled: partyId !== null,
  });
  const modes = usePaymentModes();
  return (
    <>
      <PageHeader
        title={t('books.take.title')}
        description={t('books.take.description')}
        actions={
          <Link to="/payments" {...buttonStyle('secondary')}>
            {t('books.take.back')}
          </Link>
        }
      />
      {partyId === null ? (
        <PartyPicker
          title={t('books.take.customer')}
          onPick={(picked) => {
            setParams({ partyId: picked.id });
          }}
        />
      ) : (
        <QueryState query={party} error="books.take.partyError">
          {(chosen) => (
            <div className="stack">
              <Card
                title={t('books.take.customer')}
                actions={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setParams({});
                    }}
                  >
                    {t('books.take.changeCustomer')}
                  </Button>
                }
              >
                <p>
                  <Link to={`/parties/${chosen.id}/ledger`}>{chosen.displayName}</Link>
                </p>
              </Card>
              <QueryState query={modes} error="books.take.modesError">
                {([first, ...rest]) =>
                  first === undefined ? (
                    <Alert tone="warning">{t('books.take.noModes')}</Alert>
                  ) : (
                    <PaymentForm key={chosen.id} party={chosen} modes={[first, ...rest]} />
                  )
                }
              </QueryState>
            </div>
          )}
        </QueryState>
      )}
    </>
  );
}
