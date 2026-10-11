import {
  BUYER_DETAILS_THRESHOLD_PAISE,
  priceLine,
  type GstRate,
  type IssuedInvoiceView,
  type TaxDocumentView,
} from '@paint/shared';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  PageHeader,
  Select,
  useToast,
} from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useMemo, useReducer, useRef, useState } from 'react';
import { errorMessage } from '../api/errors.js';
import type { Store } from '../api/stock.js';
import { TAX_OPTIONS_KEY } from '../api/tax.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { todayInIndia } from '../lib/india-time.js';
import { QueryState } from '../lib/QueryState.js';
import { storeLabel, useStoreAccess } from '../stock/StoreSelect.js';
import { useStores } from '../stock/stores.js';
import { billReducer, newBill, type Bill, type BillItem } from './bill.js';
import { BillLines } from './BillLines.js';
import { CustomerPanel, usePartyOverview } from './CustomerPanel.js';
import { createDraftSaver } from './draft-saver.js';
import {
  STORE_KEY,
  billFromDraft,
  currentDraft,
  forgetDraft,
  readSnapshot,
  saveSnapshot,
  setCurrentDraft,
} from './held.js';
import { HeldBills, draftsKey } from './HeldBills.js';
import { PayDialog, type CreditRoom, type Issue, type IssuedSummary } from './PayDialog.js';
import type { Endpoints } from '../api/endpoints.js';
import { PrintSlot, type PrintFormat, type PrintJob } from './PosPrint.js';
import { previewBill, ratesFrom } from './preview.js';
import { ScanBox, type LineKey } from './ScanBox.js';
import { TotalsPanel } from './TotalsPanel.js';

/** A bill is saved this long after its last change (spec §5.2: saved on every change). */
export const SAVE_DELAY_MS = 400;

const newKey = () => crypto.randomUUID();

/** The draft that was on the counter when the page was last open, if it is still a draft. */
async function resumeDraft(api: Endpoints, storeId: string): Promise<TaxDocumentView | null> {
  const draftId = currentDraft(localStorage, storeId);
  if (draftId === null) return null;
  try {
    const draft = await api.pos.invoice(draftId);
    if (draft.status === 'draft') return draft;
  } catch {
    // Gone (discarded elsewhere) or unreachable: start a fresh bill.
  }
  setCurrentDraft(localStorage, storeId, null);
  return null;
}

type SaveState =
  | { readonly state: 'idle' | 'saving' | 'saved' }
  | { readonly state: 'error'; readonly message: string };

/** The counter at one store: the bill, the customer, the total, and taking the money. */
function Counter({
  store,
  stores,
  onStore,
  rates,
  resumed,
}: {
  readonly store: Store;
  readonly stores: readonly Store[];
  readonly onStore: (storeId: string) => void;
  readonly rates: readonly GstRate[];
  readonly resumed: TaxDocumentView | null;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const unknownName = (lineNo: number) => t('pos.lines.unknownItem', { number: lineNo });
  const [bill, dispatch] = useReducer(billReducer, resumed, (draft) =>
    draft === null
      ? newBill(newKey())
      : billFromDraft(draft, readSnapshot(localStorage, draft.id), newKey(), unknownName),
  );
  const [today] = useState(todayInIndia);
  const [saver] = useState(() => createDraftSaver(api.pos));
  const [save, setSave] = useState<SaveState>({ state: 'idle' });
  const [holding, setHolding] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedSummary | null>(null);
  const [job, setJob] = useState<PrintJob | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const prints = useRef(0);
  /** The bill version last saved, and its draft. */
  const saved = useRef<{ stamp: string; draftId: string | null }>({ stamp: '', draftId: null });

  const context = useMemo(
    () => ({ storeGstin: store.gstin, rates, today }),
    [store.gstin, rates, today],
  );
  const preview = useMemo(() => previewBill(bill, context), [bill, context]);
  const amounts = preview.ok
    ? preview.invoice.lines.map((line) => line.totalPaise)
    : bill.lines.map((line) => priceLine({ ...line, categoryCode: '' }).netPaise);

  const modes = useQuery({
    queryKey: ['payment-modes'],
    queryFn: ({ signal }) => api.pos.paymentModes(signal),
  });
  const register = useQuery({
    queryKey: ['register-session', store.id],
    queryFn: ({ signal }) => api.pos.register(store.id, signal),
  });
  const credit = usePartyOverview(bill.buyer.partyId).data?.credit ?? null;
  const room: CreditRoom = {
    name: bill.buyer.partyId === null ? null : String(bill.buyer.partyName),
    availablePaise:
      credit === null ? null : credit.status === 'active' ? credit.check.availablePaise : 0,
  };

  /** Saves the bill now (after any save already under way) and answers its draft's id. */
  const persist = async (target: Bill): Promise<string | null> => {
    window.clearTimeout(timer.current);
    const stamp = `${target.key}:${String(target.version)}`;
    if (saved.current.stamp === stamp) return saved.current.draftId;
    setSave({ state: 'saving' });
    try {
      const result = await saver.save(target, store.id);
      saved.current = { stamp, draftId: result.draftId };
      dispatch({ type: 'saved', key: target.key, ...result });
      const kept = { ...target, draftId: result.draftId };
      saveSnapshot(localStorage, kept, previewBill(kept, context).payablePaise);
      setCurrentDraft(localStorage, store.id, result.draftId);
      setSave({ state: 'saved' });
      return result.draftId;
    } catch (error) {
      setSave({ state: 'error', message: errorMessage(error) });
      throw error;
    }
  };

  const autosave = useEffectEvent(() => {
    timer.current = window.setTimeout(() => {
      persist(bill).catch(() => undefined);
    }, SAVE_DELAY_MS);
  });
  useEffect(() => {
    // A bill just started or resumed has nothing new to save.
    if (bill.version === 0) return;
    autosave();
    return () => {
      window.clearTimeout(timer.current);
    };
  }, [bill.key, bill.version]);

  const startNewBill = () => {
    dispatch({ type: 'reset', key: newKey() });
    setCurrentDraft(localStorage, store.id, null);
    setSave({ state: 'idle' });
    scanRef.current?.focus();
  };

  const hold = async () => {
    if (bill.lines.length === 0) {
      toast({ title: t('pos.totals.nothingToHold') });
      return;
    }
    setHolding(true);
    try {
      await persist(bill);
      startNewBill();
      await queryClient.invalidateQueries({ queryKey: draftsKey(store.id) });
      toast({ title: t('pos.totals.held'), tone: 'success' });
    } catch {
      // The save's error is on the screen, with "Save again".
    } finally {
      setHolding(false);
    }
  };

  const resume = async (draftId: string) => {
    try {
      if (bill.lines.length > 0) await persist(bill);
      const draft = await api.pos.invoice(draftId);
      dispatch({
        type: 'load',
        bill: billFromDraft(draft, readSnapshot(localStorage, draftId), newKey(), unknownName),
      });
      setCurrentDraft(localStorage, store.id, draftId);
      setSave({ state: 'idle' });
      await queryClient.invalidateQueries({ queryKey: draftsKey(store.id) });
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' });
    }
  };

  const openPay = () => {
    // Which ways to pay there are decides the payment step, so it waits for them.
    if (bill.lines.length === 0 || modes.isPending) return;
    setIssueError(null);
    setPayOpen(true);
    // The draft is saved while the money is counted, so Enter issues at once.
    persist(bill).catch(() => undefined);
  };

  const print = (invoice: IssuedInvoiceView, format: PrintFormat) => {
    prints.current += 1;
    setJob({ id: prints.current, invoice, format });
  };

  const issue: Issue = async (payments) => {
    setIssueError(null);
    try {
      const draftId = String(await persist(bill));
      const invoice = await api.pos.issue(draftId, payments, `${bill.key}:issue`);
      forgetDraft(localStorage, draftId);
      setCurrentDraft(localStorage, store.id, null);
      setIssued({
        number: String(invoice.number),
        changePaise: invoice.changePaise,
        print: (format) => {
          print(invoice, format);
        },
      });
      print(invoice, 'thermal');
    } catch (error) {
      setIssueError(errorMessage(error));
    }
  };

  const newSale = () => {
    setPayOpen(false);
    setIssued(null);
    setJob(null);
    startNewBill();
    // After the dialog has handed the focus back: the next customer's first scan goes here.
    window.setTimeout(() => {
      scanRef.current?.focus();
    }, 0);
  };

  const onLineKey = (key: LineKey) => {
    const at = bill.selected;
    if (at === null) return;
    if (key === 'more' || key === 'less')
      dispatch({ type: 'step', index: at, by: key === 'more' ? 1 : -1 });
    else if (key === 'remove') dispatch({ type: 'remove', index: at });
    else {
      const next = at + (key === 'down' ? 1 : -1);
      dispatch({ type: 'select', index: Math.min(Math.max(next, 0), bill.lines.length - 1) });
    }
  };

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (payOpen) return;
    const actions: Record<string, () => void> = {
      F2: () => scanRef.current?.focus(),
      F4: () => {
        void hold();
      },
      F8: openPay,
    };
    const action = actions[event.key];
    if (action === undefined) return;
    event.preventDefault();
    action();
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      onKey(event);
    };
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
    };
  }, []);

  const detailsNeeded =
    preview.ok &&
    preview.invoice.buyerType === 'b2c' &&
    preview.invoice.totals.taxablePaise >= BUYER_DETAILS_THRESHOLD_PAISE;
  const session = register.data;

  return (
    <div className="pos">
      <header className="pos__bar">
        <h1 className="pos__title">{t('pos.title')}</h1>
        {stores.length > 1 ? (
          <Field
            label={t('pos.store')}
            className="pos__store"
            hint={bill.lines.length > 0 ? t('pos.storeLocked') : undefined}
          >
            <Select
              value={store.id}
              disabled={bill.lines.length > 0}
              onChange={(event) => {
                onStore(event.target.value);
              }}
            >
              {stores.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {storeLabel(choice)}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <span className="pos__store-name">{storeLabel(store)}</span>
        )}
        {session !== undefined && session.kind !== 'hidden' && (
          <Badge tone={session.kind === 'open' ? 'success' : 'warning'}>
            {session.kind === 'open'
              ? t('pos.register.open', { code: session.session.registerCode })
              : t('pos.register.closed')}
          </Badge>
        )}
        <span className="pos__status" role="status">
          {save.state === 'saving' && t('pos.saving')}
          {save.state === 'saved' && t('pos.saved')}
        </span>
        <HeldBills
          storeId={store.id}
          currentDraftId={bill.draftId}
          onResume={(draftId) => {
            void resume(draftId);
          }}
        />
      </header>
      {store.gstin === null && <Alert tone="warning">{t('pos.unregistered')}</Alert>}
      {save.state === 'error' && (
        <Alert
          tone="danger"
          action={
            <Button
              variant="secondary"
              onClick={() => {
                persist(bill).catch(() => undefined);
              }}
            >
              {t('pos.saveAgain')}
            </Button>
          }
        >
          {t('pos.notSaved', { message: save.message })}
        </Alert>
      )}
      <div className="pos__grid">
        <section className="pos__main" aria-label={t('pos.lines.label')}>
          <ScanBox
            inputRef={scanRef}
            onAdd={(item: BillItem, quantity: number) => {
              dispatch({ type: 'add', item, quantity });
            }}
            onLineKey={onLineKey}
            onQuantity={(quantity) => {
              if (bill.selected !== null) {
                dispatch({ type: 'quantity', index: bill.selected, quantity });
              }
            }}
          />
          <BillLines
            lines={bill.lines}
            amounts={amounts}
            selected={bill.selected}
            partyId={bill.buyer.partyId}
            dispatch={dispatch}
            focusWhenEmpty={scanRef}
          />
          <p className="pos__keys muted">
            <Icon name="check" size={14} /> {t('pos.keys')}
          </p>
        </section>
        <div className="pos__side">
          <CustomerPanel buyer={bill.buyer} dispatch={dispatch} detailsNeeded={detailsNeeded} />
          <TotalsPanel
            preview={preview}
            lineCount={bill.lines.length}
            exclusive={bill.priceMode === 'exclusive'}
            holding={holding}
            onHold={() => {
              void hold();
            }}
            onPay={openPay}
          />
        </div>
      </div>
      <PayDialog
        open={payOpen}
        onClose={() => {
          setPayOpen(false);
        }}
        totalPaise={preview.payablePaise}
        // A failed load leaves no way to pay: the bill can still be issued unpaid.
        modes={modes.data ?? []}
        registerSessionId={session?.kind === 'open' ? session.session.id : null}
        room={room}
        onIssue={issue}
        error={issueError}
        issued={issued}
        onNewSale={newSale}
      />
      <PrintSlot job={job} />
    </div>
  );
}

/** Loads what the counter needs at a store (GST rates, the bill left open), then opens it. */
function StoreCounter({
  store,
  stores,
  onStore,
}: {
  readonly store: Store;
  readonly stores: readonly Store[];
  readonly onStore: (storeId: string) => void;
}) {
  const api = useApi();
  const options = useQuery({
    queryKey: TAX_OPTIONS_KEY,
    queryFn: ({ signal }) => api.tax.options(signal),
  });
  const resumed = useQuery({
    queryKey: ['pos-resume', store.id],
    queryFn: () => resumeDraft(api, store.id),
    // Read afresh whenever the counter opens.
    gcTime: 0,
  });
  return (
    <QueryState query={options} error="pos.loadError">
      {(taxOptions) => (
        <QueryState query={resumed} error="pos.loadError">
          {(draft) => (
            <Counter
              store={store}
              stores={stores}
              onStore={onStore}
              rates={ratesFrom(taxOptions, todayInIndia())}
              resumed={draft}
            />
          )}
        </QueryState>
      )}
    </QueryState>
  );
}

/** /pos — the counter sale screen (spec §5.2): a 3-item bill in under a minute. */
export function PosPage() {
  const { t } = useI18n();
  const stores = useStores();
  const access = useStoreAccess();
  const [chosen, setChosen] = useState(() => localStorage.getItem(STORE_KEY) ?? '');
  return (
    <QueryState query={stores} error="pos.loadError">
      {(list) => {
        // Bills are made at the stores the member works at, not at godowns.
        const choices = list.filter(
          (store) => store.isActive && store.type === 'store' && access(store.id),
        );
        const store = choices.find((choice) => choice.id === chosen) ?? choices[0];
        if (store === undefined) {
          return (
            <>
              <PageHeader title={t('pos.title')} />
              <EmptyState icon={<Icon name="store" size={32} />} title={t('pos.noStore')} />
            </>
          );
        }
        return (
          <StoreCounter
            key={store.id}
            store={store}
            stores={choices}
            onStore={(storeId) => {
              localStorage.setItem(STORE_KEY, storeId);
              setChosen(storeId);
            }}
          />
        );
      }}
    </QueryState>
  );
}
