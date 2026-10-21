import { CURRENT_GST_STATES } from '@paint/shared';
import { Button, Card, Field, Input, Select, Textarea } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type Dispatch } from 'react';
import { errorMessage } from '../api/errors.js';
import type { Party } from '../api/parties.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { stateLabel } from '../lib/gst-states.js';
import { PartyField } from '../orders/SalesDocEditor.js';
import { INFLUENCER_ROLES } from '../orders/sales-doc.js';
import { useLandingOnChange } from '../sales/focus-landing.js';
import { WALK_IN, buyerGstin, type Bill, type BillAction, type Buyer } from './bill.js';

/** The customer 360 summary (credit and loyalty), shared with the customer's page. */
export function usePartyOverview(partyId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['party', String(partyId)],
    queryFn: ({ signal }) => api.parties.overview(String(partyId), signal),
    enabled: partyId !== null,
  });
}

/** The last ten digits of a phone number, as typed or stored ("+91 98480 12345"). */
const lastTen = (phone: string) => phone.replace(/\D/g, '').slice(-10);

function CustomerFacts({ partyId }: { readonly partyId: string }) {
  const { t, money, number } = useI18n();
  const overview = usePartyOverview(partyId);
  const credit = overview.data?.credit ?? null;
  const loyalty = overview.data?.loyalty ?? null;
  return (
    <ul className="pos-customer__facts">
      {credit !== null && (
        <li>
          {credit.status === 'active'
            ? t('pos.customer.credit', { amount: money(Math.max(0, credit.check.availablePaise)) })
            : credit.status === 'on_hold'
              ? t('pos.customer.creditHold')
              : t('pos.customer.noCredit')}
        </li>
      )}
      {(loyalty?.account ?? null) !== null && (
        <li>{t('pos.customer.loyalty', { points: number(Number(loyalty?.balance)) })}</li>
      )}
    </ul>
  );
}

/**
 * Who the bill is for (spec §5.2 step 3): a mobile number finds the customer, with
 * their credit and points; left blank, the sale is walk-in. A GSTIN makes it B2B.
 */
export function CustomerPanel({
  buyer,
  painter,
  dispatch,
  detailsNeeded,
}: {
  readonly buyer: Buyer;
  /** The painter who brought the sale, who earns its points. */
  readonly painter: Bill['painter'];
  readonly dispatch: Dispatch<BillAction>;
  /** Rule 46(e): a B2C bill of ₹50,000 or more needs the buyer's name, address and state. */
  readonly detailsNeeded: boolean;
}) {
  const api = useApi();
  const { t } = useI18n();
  const [mobile, setMobile] = useState('');
  const [found, setFound] = useState<Party[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mobileRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  // Choosing a customer, or going back to walk-in, swaps the controls that had the focus.
  useLandingOnChange(buyer.partyId, buyer.partyId === null ? mobileRef : changeRef);

  const choose = (party: Party) => {
    dispatch({
      type: 'buyer',
      buyer: {
        partyId: party.id,
        partyName: party.displayName,
        phone: party.phone,
        gstin: party.gstin ?? '',
      },
    });
    setFound(null);
    setMobile('');
  };

  const find = async () => {
    const digits = lastTen(mobile);
    if (digits === '') return;
    setBusy(true);
    setMessage(null);
    try {
      const page = await api.parties.list({ q: digits, limit: 5 });
      const matches = page.items.filter((party) =>
        [party.phone, party.alternatePhone].some(
          (phone) => phone !== null && lastTen(phone) === digits,
        ),
      );
      const [only] = matches;
      if (only !== undefined && matches.length === 1) choose(only);
      else if (only === undefined) setMessage(t('pos.customer.notFound'));
      else setFound(matches);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const gstinTyped = buyer.gstin.trim() !== '';
  const gstinInvalid = gstinTyped && buyer.gstin.trim().length >= 15 && buyerGstin(buyer) === null;
  const showDetails =
    detailsNeeded || buyerGstin(buyer) !== null || buyer.name !== '' || buyer.address !== '';

  return (
    <Card title={t('pos.customer.title')} className="pos-customer">
      <div className="stack">
        {buyer.partyId === null ? (
          <>
            <div className="pos-customer__find">
              <Field
                label={t('pos.customer.mobile')}
                hint={t('pos.customer.mobileHint')}
                error={message ?? undefined}
              >
                <Input
                  ref={mobileRef}
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  value={mobile}
                  onChange={(event) => {
                    setMobile(event.target.value);
                    setMessage(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    void find();
                  }}
                />
              </Field>
              <Button
                variant="secondary"
                loading={busy}
                onClick={() => {
                  void find();
                }}
              >
                {t('pos.customer.find')}
              </Button>
            </div>
            {found !== null && (
              <div role="group" aria-label={t('pos.customer.several')} className="stack">
                <p className="muted">{t('pos.customer.several')}</p>
                {found.map((party) => (
                  <Button
                    key={party.id}
                    variant="secondary"
                    onClick={() => {
                      choose(party);
                    }}
                  >
                    {t('pos.customer.choose', { name: party.displayName })}
                  </Button>
                ))}
              </div>
            )}
            <p className="pos-customer__who">{t('pos.customer.walkIn')}</p>
          </>
        ) : (
          <div className="pos-customer__chosen">
            <p className="pos-customer__who">
              {buyer.partyName}
              {buyer.phone === null ? '' : ` · ${buyer.phone}`}
            </p>
            <CustomerFacts partyId={buyer.partyId} />
            <Button
              ref={changeRef}
              variant="ghost"
              size="sm"
              onClick={() => {
                dispatch({ type: 'buyer', buyer: WALK_IN });
              }}
            >
              {t('pos.customer.change')}
            </Button>
          </div>
        )}
        <Field
          label={t('pos.customer.gstin')}
          hint={t('pos.customer.gstinHint')}
          error={gstinInvalid ? t('pos.customer.gstinInvalid') : undefined}
        >
          <Input
            autoComplete="off"
            autoCapitalize="characters"
            maxLength={15}
            value={buyer.gstin}
            onChange={(event) => {
              dispatch({ type: 'buyer', buyer: { gstin: event.target.value.toUpperCase() } });
            }}
          />
        </Field>
        {showDetails && (
          <fieldset className="plain-fieldset stack">
            <legend className="subheading">{t('pos.customer.details')}</legend>
            {detailsNeeded && <p className="muted">{t('pos.customer.detailsNeeded')}</p>}
            <Field label={t('pos.customer.name')}>
              <Input
                value={buyer.name}
                maxLength={160}
                onChange={(event) => {
                  dispatch({ type: 'buyer', buyer: { name: event.target.value } });
                }}
              />
            </Field>
            <Field label={t('pos.customer.address')}>
              <Textarea
                rows={2}
                maxLength={300}
                value={buyer.address}
                onChange={(event) => {
                  dispatch({ type: 'buyer', buyer: { address: event.target.value } });
                }}
              />
            </Field>
            <Field label={t('pos.customer.state')}>
              <Select
                value={buyer.stateCode}
                onChange={(event) => {
                  dispatch({ type: 'buyer', buyer: { stateCode: event.target.value } });
                }}
              >
                <option value="">{t('pos.customer.chooseState')}</option>
                {CURRENT_GST_STATES.map((state) => (
                  <option key={state.code} value={state.code}>
                    {stateLabel(state.code)}
                  </option>
                ))}
              </Select>
            </Field>
          </fieldset>
        )}
      </div>
      <PartyField
        label={t('pos.painter.label')}
        hint={t('pos.painter.hint')}
        value={painter}
        check={(party) =>
          party.roles.some((role) => (INFLUENCER_ROLES as readonly string[]).includes(role))
            ? null
            : t('orders.editor.notInfluencer', { name: party.displayName })
        }
        onChange={(chosen) => {
          dispatch({ type: 'painter', painter: chosen });
        }}
      />
    </Card>
  );
}
