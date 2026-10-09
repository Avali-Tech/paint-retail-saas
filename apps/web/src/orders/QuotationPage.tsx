import {
  ORDERS_PERMISSION,
  PAYMENT_TERMS,
  type PaymentTerms,
  type QuotationView,
} from '@paint/shared';
import {
  Badge,
  Button,
  Card,
  Field,
  PageHeader,
  Select,
  Textarea,
  buttonStyle,
  useToast,
} from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { QueryState } from '../lib/QueryState.js';
import { usePageLanding } from '../sales/focus-landing.js';
import { LinesTable } from '../sales/LinesTable.js';
import { TaxTotals } from '../sales/TaxTotals.js';
import { StoreSelect, storeLabel } from '../stock/StoreSelect.js';
import { useStores } from '../stock/stores.js';
import { DocumentFacts } from './DocumentFacts.js';
import { QuotationPrintSlot, type QuotationPrintJob } from './QuotationPrint.js';
import { QUOTATION_TONE, whatsappLink } from './status.js';

/** "Convert to order": payment terms and where the goods come from (spec §5.3). */
function ConvertDialog({
  quotation,
  onClose,
}: {
  readonly quotation: QuotationView;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, label } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [terms, setTerms] = useState<PaymentTerms>('postpaid');
  const [storeId, setStoreId] = useState(quotation.storeId);
  const [note, setNote] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('orders.convert.title', { number: quotation.number })}
      description={t('orders.convert.description')}
      submitLabel={t('orders.convert.submit')}
      onSubmit={async () => {
        const trimmed = note.trim();
        const order = await api.orders.convertQuotation(
          quotation.id,
          {
            paymentTerms: terms,
            ...(storeId === '' ? {} : { fulfilStoreId: storeId }),
            ...(trimmed === '' ? {} : { note: trimmed }),
          },
          key,
        );
        await queryClient.invalidateQueries({ queryKey: ['quotations'] });
        void navigate(`/sales-orders/${order.id}`);
        return undefined;
      }}
    >
      <Field label={t('orders.editor.paymentTerms')}>
        <Select
          value={terms}
          onChange={(event) => {
            // The select offers only PAYMENT_TERMS.
            setTerms(event.target.value as PaymentTerms);
          }}
        >
          {PAYMENT_TERMS.map((value) => (
            <option key={value} value={value}>
              {label('paymentTerms', value)}
            </option>
          ))}
        </Select>
      </Field>
      <StoreSelect
        label={t('orders.convert.fulfilStore')}
        value={storeId}
        onChange={setStoreId}
        emptyLabel={t('orders.convert.sameStore')}
      />
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

function QuotationDetail({ quotation }: { readonly quotation: QuotationView }) {
  const api = useApi();
  const can = usePermissions();
  const profile = useCurrentProfile();
  const stores = useStores();
  const { t, label, money, date } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [converting, setConverting] = useState(false);
  const [job, setJob] = useState<QuotationPrintJob | null>(null);
  const prints = useRef(0);
  usePageLanding(!converting, quotation);
  const manage = can(ORDERS_PERMISSION);
  const { status } = quotation;
  const store = stores.data?.find((candidate) => candidate.id === quotation.storeId);

  /** Runs a status change, then shows the version it answers with. */
  const act = async (run: () => Promise<QuotationView>, done: string) => {
    setBusy(true);
    try {
      const next = await run();
      await queryClient.invalidateQueries({ queryKey: ['quotations'] });
      toast({ title: done, tone: 'success' });
      if (next.id !== quotation.id) void navigate(`/quotations/${next.id}`);
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const share = t('orders.share.message', {
    business: profile.organization.name,
    number: quotation.number,
    version: quotation.version,
    total: money(quotation.totalPaise),
    date: date(quotation.validUntil),
  });

  const actions = manage && (
    <div className="row">
      {status === 'draft' && (
        <>
          <Link to={`/quotations/${quotation.id}/edit`} {...buttonStyle('secondary')}>
            {t('common.edit')}
          </Link>
          <Button
            loading={busy}
            onClick={() => {
              void act(() => api.orders.sendQuotation(quotation.id), t('orders.quotation.sent'));
            }}
          >
            {t('orders.quotation.send')}
          </Button>
        </>
      )}
      {status === 'sent' && (
        <Button
          variant="secondary"
          loading={busy}
          onClick={() => {
            void act(
              () => api.orders.acceptQuotation(quotation.id),
              t('orders.quotation.accepted'),
            );
          }}
        >
          {t('orders.quotation.accept')}
        </Button>
      )}
      {(status === 'sent' || status === 'accepted' || status === 'expired') && (
        <Button
          variant="secondary"
          loading={busy}
          onClick={() => {
            void act(() => api.orders.reviseQuotation(quotation.id), t('orders.quotation.revised'));
          }}
        >
          {t('orders.quotation.revise')}
        </Button>
      )}
      {(status === 'sent' || status === 'accepted') && (
        <Button
          onClick={() => {
            setConverting(true);
          }}
        >
          {t('orders.quotation.convert')}
        </Button>
      )}
    </div>
  );

  return (
    <>
      <PageHeader
        title={t('orders.quotation.title', {
          number: quotation.number,
          version: quotation.version,
        })}
        description={t('orders.quotation.validUntil', { date: date(quotation.validUntil) })}
        actions={actions}
      />
      <DocumentFacts
        document={quotation}
        badge={<Badge tone={QUOTATION_TONE[status]}>{label('quotationStatuses', status)}</Badge>}
        storeName={store === undefined ? null : storeLabel(store)}
        extra={
          quotation.salesOrderId === null
            ? []
            : [
                [
                  t('orders.quotation.order'),
                  <Link key="order" to={`/sales-orders/${quotation.salesOrderId}`}>
                    {t('orders.quotation.openOrder')}
                  </Link>,
                ],
              ]
        }
      />
      <Card title={t('sales.lines.title')}>
        <div className="stack">
          <LinesTable lines={quotation.lines} />
          <TaxTotals totals={quotation} />
        </div>
      </Card>
      <Card title={t('orders.share.title')}>
        <div className="stack">
          <p className="muted">{t('orders.share.hint')}</p>
          <div className="row">
            <Button
              variant="secondary"
              onClick={() => {
                prints.current += 1;
                setJob({
                  id: prints.current,
                  quotation,
                  businessName: profile.organization.name,
                  storeName: store?.name ?? null,
                });
              }}
            >
              {t('orders.share.print')}
            </Button>
            <a
              {...buttonStyle('secondary')}
              href={whatsappLink(quotation.billTo.phone, share)}
              target="_blank"
              rel="noreferrer"
            >
              {t('orders.share.whatsapp')}
            </a>
          </div>
        </div>
      </Card>
      <Card title={t('orders.quotation.versions')}>
        <ol className="record-list">
          {quotation.versions.map((version) => (
            <li key={version.id} className="record-list__row">
              {version.id === quotation.id ? (
                <span aria-current="page">
                  {t('orders.quotation.version', { version: version.version })}
                </span>
              ) : (
                <Link to={`/quotations/${version.id}`}>
                  {t('orders.quotation.version', { version: version.version })}
                </Link>
              )}
              <span className="record-list__meta">
                {`${label('quotationStatuses', version.status)} · ${money(version.totalPaise)}`}
              </span>
            </li>
          ))}
        </ol>
      </Card>
      {converting && (
        <ConvertDialog
          quotation={quotation}
          onClose={() => {
            setConverting(false);
          }}
        />
      )}
      <QuotationPrintSlot job={job} />
    </>
  );
}

/** The quotation in the address, loaded. */
function useQuotation() {
  const api = useApi();
  // The route always has an :id.
  const id = String(useParams().id);
  return useQuery({
    queryKey: ['quotations', id],
    queryFn: ({ signal }) => api.orders.quotation(id, signal),
  });
}

/** /quotations/:id — one version of a quote: send, accept, revise, convert, print and share. */
export function QuotationPage() {
  const quotation = useQuotation();
  return (
    <QueryState query={quotation} error="orders.quotation.error">
      {(data) => <QuotationDetail key={data.id} quotation={data} />}
    </QueryState>
  );
}
