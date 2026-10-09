import {
  CURRENT_GST_STATES,
  PAYMENT_TERMS,
  priceLine,
  type PaymentTerms,
  type QuotationView,
  type SalesOrderView,
} from '@paint/shared';
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  useToast,
} from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useReducer, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../api/errors.js';
import type { Party } from '../api/parties.js';
import { useApi } from '../app/services.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { stateLabel } from '../lib/gst-states.js';
import { todayInIndia } from '../lib/india-time.js';
import { PartyPicker } from '../parties/PartyPicker.js';
import { billReducer } from '../pos/bill.js';
import { BillLines } from '../pos/BillLines.js';
import { ScanBox } from '../pos/ScanBox.js';
import { StoreSelect } from '../stock/StoreSelect.js';
import {
  INFLUENCER_ROLES,
  editorStateOf,
  lineKeyAction,
  orderRequest,
  problemsOf,
  quotationRequest,
  type ChosenParty,
  type HeaderProblem,
  type Problems,
  type SalesHeader,
} from './sales-doc.js';

export type EditorKind = 'quotation' | 'order';

const PROBLEM_TEXT: Record<HeaderProblem, MessageKey> = {
  required: 'common.required',
  pastDate: 'orders.editor.pastDate',
  shipToState: 'orders.editor.shipToStateNeeded',
  noteLong: 'orders.editor.noteLong',
  noLines: 'orders.editor.noLines',
  tooManyLines: 'orders.editor.tooManyLines',
};

/** A party on the document: who it is, with "Change" / "Remove", or a picker to choose one. */
export function PartyField({
  label,
  hint,
  value,
  onChange,
  error,
  check,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: ChosenParty | null;
  readonly onChange: (party: ChosenParty | null) => void;
  readonly error?: string | undefined;
  /** A message when this party cannot be chosen here. */
  readonly check?: (party: Party) => string | null;
}) {
  const { t } = useI18n();
  const [picking, setPicking] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const problem = refused ?? error;
  return (
    <div className="orders-party">
      <Field label={label} hint={hint} error={problem}>
        <Input readOnly value={value?.name ?? ''} placeholder={t('orders.editor.nobody')} />
      </Field>
      <div className="row">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setPicking(!picking);
          }}
        >
          {value === null
            ? t('orders.editor.choose', { what: label })
            : t('orders.editor.change', { what: label })}
        </Button>
        {value !== null && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onChange(null);
            }}
          >
            {t('orders.editor.remove', { what: label })}
          </Button>
        )}
      </div>
      {picking && (
        <PartyPicker
          title={label}
          onPick={(party) => {
            const message = check?.(party) ?? null;
            setRefused(message);
            if (message !== null) return;
            onChange({ id: party.id, name: party.displayName });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

/** The bill-to party's sites (projects), to pick the one the goods go to. */
function SiteSelect({
  partyId,
  value,
  onChange,
}: {
  readonly partyId: string | null;
  readonly value: string;
  readonly onChange: (projectId: string) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const projects = useQuery({
    queryKey: ['projects', { partyId, picker: true }],
    queryFn: ({ signal }) =>
      api.projects.list({ partyId: String(partyId), limit: 50, offset: 0 }, signal),
    enabled: partyId !== null,
  });
  return (
    <Field label={t('orders.editor.site')} hint={t('orders.editor.siteHint')}>
      <Select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">{t('orders.editor.noSite')}</option>
        {(projects.data?.items ?? []).map((project) => (
          <option key={project.id} value={project.id}>
            {`${project.number} · ${project.name}`}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/**
 * The quotation and order editor (spec §5.3, §6.4): store, bill-to, influencer and
 * site, ship-to, validity (quotes) or payment terms (orders), and the same line grid
 * as the counter. The server prices it with the GST engine when it is saved.
 */
export function SalesDocEditor({
  kind,
  existing,
}: {
  readonly kind: EditorKind;
  /** A draft being edited; null for a new one. */
  readonly existing: QuotationView | SalesOrderView | null;
}) {
  const api = useApi();
  const { t, money, label } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [initial] = useState(() => editorStateOf(existing));
  const [header, setHeader] = useState<SalesHeader>(initial.header);
  const [bill, dispatch] = useReducer(billReducer, initial.bill);
  const [problems, setProblems] = useState<Problems>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const [today] = useState(todayInIndia);
  const scanRef = useRef<HTMLInputElement>(null);

  const set = (change: Partial<SalesHeader>) => {
    setHeader((current) => ({ ...current, ...change }));
  };
  const problem = (field: keyof Problems) => {
    const found = problems[field];
    return found === undefined ? undefined : t(PROBLEM_TEXT[found]);
  };
  const amounts = bill.lines.map((line) => priceLine({ ...line, categoryCode: '' }).netPaise);
  const linesTotal = amounts.reduce((sum, amount) => sum + amount, 0);
  const base = kind === 'quotation' ? '/quotations' : '/sales-orders';

  const save = async () => {
    const found = problemsOf(header, bill.lines, today, kind);
    setProblems(found);
    setMessage(null);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    try {
      let id: string;
      if (kind === 'quotation') {
        const body = quotationRequest(header, bill.lines);
        id = (
          existing === null
            ? await api.orders.createQuotation(body, key)
            : await api.orders.updateQuotation(existing.id, body)
        ).id;
      } else {
        const body = orderRequest(header, bill.lines);
        id = (
          existing === null
            ? await api.orders.createOrder(body, key)
            : await api.orders.updateOrder(existing.id, body)
        ).id;
      }
      await queryClient.invalidateQueries({
        queryKey: [kind === 'quotation' ? 'quotations' : 'sales-orders'],
      });
      toast({ title: t('orders.editor.saved'), tone: 'success' });
      void navigate(`${base}/${id}`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const title =
    existing === null
      ? t(kind === 'quotation' ? 'orders.editor.newQuotation' : 'orders.editor.newOrder')
      : t('orders.editor.editing', { number: existing.number });

  return (
    <>
      <PageHeader title={title} description={t('orders.editor.description')} />
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {message !== null && <Alert tone="danger">{message}</Alert>}
        <Card title={t('orders.editor.who')}>
          <div className="form-grid">
            <StoreSelect
              label={t('orders.editor.store')}
              value={header.storeId}
              onChange={(storeId) => {
                set({ storeId });
              }}
              emptyLabel={t('orders.editor.chooseStore')}
              error={problem('storeId')}
              required
            />
            <PartyField
              label={t('orders.editor.billTo')}
              hint={t('orders.editor.billToHint')}
              value={header.billTo}
              error={problem('billTo')}
              onChange={(billTo) => {
                // Sites belong to the bill-to party.
                set({ billTo, projectId: '' });
              }}
            />
            <PartyField
              label={t('orders.editor.influencer')}
              hint={t('orders.editor.influencerHint')}
              value={header.influencer}
              check={(party) =>
                party.roles.some((role) => (INFLUENCER_ROLES as readonly string[]).includes(role))
                  ? null
                  : t('orders.editor.notInfluencer', { name: party.displayName })
              }
              onChange={(influencer) => {
                set({ influencer });
              }}
            />
            <SiteSelect
              partyId={header.billTo?.id ?? null}
              value={header.projectId}
              onChange={(projectId) => {
                set({ projectId });
              }}
            />
          </div>
        </Card>
        <Card title={t('orders.editor.shipTo')}>
          <div className="form-grid">
            <Field label={t('orders.editor.shipToName')}>
              <Input
                value={header.shipToName}
                onChange={(event) => {
                  set({ shipToName: event.target.value });
                }}
              />
            </Field>
            <Field label={t('orders.editor.shipToAddress')}>
              <Textarea
                rows={2}
                value={header.shipToAddress}
                onChange={(event) => {
                  set({ shipToAddress: event.target.value });
                }}
              />
            </Field>
            <Field
              label={t('orders.editor.shipToState')}
              hint={t('orders.editor.shipToHint')}
              error={problem('shipToState')}
            >
              <Select
                value={header.shipToState}
                onChange={(event) => {
                  set({ shipToState: event.target.value });
                }}
              >
                <option value="">{t('orders.editor.noShipTo')}</option>
                {CURRENT_GST_STATES.map((state) => (
                  <option key={state.code} value={state.code}>
                    {stateLabel(state.code)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>
        <Card title={t('orders.editor.terms')}>
          <div className="form-grid">
            {kind === 'quotation' ? (
              <Field
                label={t('orders.editor.validUntil')}
                hint={t('orders.editor.validUntilHint')}
                error={problem('validUntil')}
              >
                <Input
                  type="date"
                  min={today}
                  value={header.validUntil}
                  onChange={(event) => {
                    set({ validUntil: event.target.value });
                  }}
                />
              </Field>
            ) : (
              <Field label={t('orders.editor.paymentTerms')}>
                <Select
                  value={header.paymentTerms}
                  onChange={(event) => {
                    // The select offers only PAYMENT_TERMS.
                    set({ paymentTerms: event.target.value as PaymentTerms });
                  }}
                >
                  {PAYMENT_TERMS.map((terms) => (
                    <option key={terms} value={terms}>
                      {label('paymentTerms', terms)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label={t('orders.editor.note')} error={problem('note')}>
              <Textarea
                rows={2}
                value={header.note}
                onChange={(event) => {
                  set({ note: event.target.value });
                }}
              />
            </Field>
          </div>
        </Card>
        <Card title={t('orders.editor.lines')}>
          <div className="stack">
            <ScanBox
              inputRef={scanRef}
              onAdd={(item, quantity) => {
                dispatch({ type: 'add', item, quantity });
              }}
              onLineKey={(lineKey) => {
                const action = lineKeyAction(bill, lineKey);
                if (action !== null) dispatch(action);
              }}
              onQuantity={(quantity) => {
                if (bill.selected !== null) {
                  dispatch({ type: 'quantity', index: bill.selected, quantity });
                }
              }}
            />
            {problems.lines !== undefined && (
              <Alert tone="danger">{t(PROBLEM_TEXT[problems.lines])}</Alert>
            )}
            <BillLines
              lines={bill.lines}
              amounts={amounts}
              selected={bill.selected}
              partyId={header.billTo?.id ?? null}
              dispatch={dispatch}
            />
            <p className="orders-editor__total">
              {t('orders.editor.linesTotal', { amount: money(linesTotal) })}
            </p>
            <p className="muted">{t('orders.editor.pricedOnSave')}</p>
          </div>
        </Card>
        <div className="row row--end">
          <Button
            variant="secondary"
            onClick={() => {
              void navigate(existing === null ? base : `${base}/${existing.id}`);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={saving}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </>
  );
}
