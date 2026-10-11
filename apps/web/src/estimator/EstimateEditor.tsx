import { ESTIMATES_PERMISSION, type EstimateTier, type EstimateView } from '@paint/shared';
import { Alert, Button, Card, Field, Input, PageHeader, useToast } from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { PartyField } from '../orders/SalesDocEditor.js';
import { usePageLanding } from '../sales/focus-landing.js';
import { StoreSelect } from '../stock/StoreSelect.js';
import {
  checkDraft,
  draftOf,
  estimateRequest,
  liveTiers,
  newDraft,
  type DraftCheck,
  type EstimateDraft,
} from './estimate-form.js';
import type { PaintProduct } from './estimator-api.js';
import { OptionsCard } from './OptionsCard.js';
import { blankRoom, type RoomDraft } from './rooms.js';
import { RoomsCard } from './RoomsCard.js';

type Problem = NonNullable<DraftCheck['problem']> | 'customer';

const PROBLEM_TEXT: Record<Problem, MessageKey> = {
  store: 'estimator.problems.store',
  rooms: 'estimator.problems.rooms',
  noRooms: 'estimator.problems.noRooms',
  tooMany: 'estimator.problems.tooMany',
  wastage: 'estimator.problems.wastage',
  customer: 'estimator.problems.customer',
};

/**
 * The estimate screen (spec §6.2): rooms with their live area, three tiers side by
 * side with live litres and packs (the same pure estimator the server runs), save,
 * and "Make quotation" from one tier. A new estimate stays on screen once saved.
 */
export function EstimateEditor({
  existing,
  products,
  onSaved,
}: {
  readonly existing: EstimateView | null;
  /** The existing estimate's products, by id, with their packs. */
  readonly products: ReadonlyMap<string, PaintProduct>;
  /** Called after every save, e.g. to move a new estimate's address to its id. */
  readonly onSaved: (estimate: EstimateView) => void;
}) {
  const api = useApi();
  const can = usePermissions();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<EstimateDraft>(() =>
    existing === null
      ? newDraft('', t('estimator.rooms.defaultName', { n: 1 }))
      : draftOf(existing, products),
  );
  const [saved, setSaved] = useState<{ id: string; number: string } | null>(existing);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createKey] = useState(() => crypto.randomUUID());
  const [convertKey] = useState(() => crypto.randomUUID());
  const rooms = useRef(draft.rooms.length);
  usePageLanding(true);
  const check = useMemo(() => checkDraft(draft), [draft]);
  const outcomes = useMemo(() => liveTiers(draft, check), [draft, check]);
  const writer = can(ESTIMATES_PERMISSION);

  const set = (change: Partial<EstimateDraft>) => {
    setDraft((current) => ({ ...current, ...change }));
    setProblem(null);
  };
  const setRoom = (key: string, change: Partial<RoomDraft>) => {
    setDraft((current) => ({
      ...current,
      rooms: current.rooms.map((room) => (room.key === key ? { ...room, ...change } : room)),
    }));
  };

  /** Saves and prices the estimate; null when something stops it. */
  const save = async (): Promise<EstimateView | null> => {
    if (check.problem !== null) {
      setProblem(check.problem);
      return null;
    }
    const body = estimateRequest(draft, check);
    const stored =
      saved === null
        ? await api.estimator.createEstimate(body, createKey)
        : await api.estimator.updateEstimate(saved.id, body);
    const computed = await api.estimator.computeEstimate(stored.id);
    queryClient.setQueryData(['estimates', computed.id], computed);
    await queryClient.invalidateQueries({ queryKey: ['estimate-list'] });
    onSaved(computed);
    setSaved(computed);
    return computed;
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const onSave = () =>
    run(async () => {
      if ((await save()) !== null) toast({ title: t('estimator.editor.saved'), tone: 'success' });
    });

  const onQuote = (tier: EstimateTier) =>
    run(async () => {
      if (draft.party === null) {
        setProblem('customer');
        return;
      }
      const estimate = await save();
      if (estimate === null) return;
      const quote = await api.estimator.convertEstimate(estimate.id, { tier }, convertKey);
      await queryClient.invalidateQueries({ queryKey: ['quotations'] });
      await queryClient.invalidateQueries({ queryKey: ['estimate-list'] });
      await queryClient.invalidateQueries({ queryKey: ['estimates', estimate.id] });
      toast({ title: t('estimator.options.quoted', { number: quote.number }), tone: 'success' });
      void navigate(`/quotations/${quote.id}`);
    });

  return (
    <>
      <PageHeader
        title={
          saved === null
            ? t('estimator.editor.newTitle')
            : t('estimator.editor.title', { number: saved.number })
        }
        description={t('estimator.editor.description')}
      />
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void onSave();
        }}
      >
        {message !== null && <Alert tone="danger">{message}</Alert>}
        <Card title={t('estimator.editor.who')}>
          <div className="form-grid">
            <StoreSelect
              label={t('estimator.editor.store')}
              value={draft.storeId}
              onChange={(storeId) => {
                set({ storeId });
              }}
              emptyLabel={t('estimator.editor.chooseStore')}
              error={problem === 'store' ? t(PROBLEM_TEXT.store) : undefined}
              required
            />
            <PartyField
              label={t('estimator.editor.customer')}
              hint={t('estimator.editor.customerHint')}
              value={draft.party}
              error={problem === 'customer' ? t(PROBLEM_TEXT.customer) : undefined}
              onChange={(party) => {
                set({ party });
              }}
            />
            <Field
              label={t('estimator.editor.estimateTitle')}
              hint={t('estimator.editor.titleHint')}
            >
              <Input
                value={draft.title}
                onChange={(event) => {
                  set({ title: event.target.value });
                }}
              />
            </Field>
            <Field
              label={t('estimator.editor.wastage')}
              hint={t('estimator.editor.wastageHint')}
              error={check.wastageBps === null ? t(PROBLEM_TEXT.wastage) : undefined}
            >
              <Input
                inputMode="decimal"
                value={draft.wastage}
                onChange={(event) => {
                  set({ wastage: event.target.value });
                }}
              />
            </Field>
          </div>
        </Card>
        <RoomsCard
          rooms={check.rooms}
          onChange={setRoom}
          onAdd={() => {
            rooms.current += 1;
            const n = rooms.current;
            set({
              rooms: [
                ...draft.rooms,
                blankRoom(`room-${String(n)}`, t('estimator.rooms.defaultName', { n })),
              ],
            });
          }}
          onRemove={(key) => {
            set({ rooms: draft.rooms.filter((room) => room.key !== key) });
          }}
        />
        <OptionsCard
          tiers={draft.tiers}
          primer={draft.primer}
          putty={draft.putty}
          outcomes={outcomes}
          busy={busy || !writer}
          onTier={(tier, product) => {
            set({ tiers: { ...draft.tiers, [tier]: product } });
          }}
          onPrimer={(primer) => {
            set({ primer });
          }}
          onPutty={(putty) => {
            set({ putty });
          }}
          onQuote={(tier) => {
            void onQuote(tier);
          }}
        />
        {problem !== null && problem !== 'store' && problem !== 'customer' && (
          <Alert tone="warning">{t(PROBLEM_TEXT[problem])}</Alert>
        )}
        {writer && (
          <div className="row">
            <Button type="submit" disabled={busy}>
              {t('estimator.editor.save')}
            </Button>
          </div>
        )}
      </form>
    </>
  );
}
