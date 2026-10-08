import { Alert, Badge, Card, PageHeader } from '@paint/ui';
import {
  NOTES_PERMISSION,
  type InvoiceAdjustments,
  type NoteKind,
  type TaxDocumentView,
} from '@paint/shared';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { STATUS_TONE } from './InvoicesPage.js';
import { LinesTable } from './LinesTable.js';
import { NoteDialog } from './NoteDialog.js';
import { NotesTable } from './NotesTable.js';
import { ReturnDialog } from './ReturnDialog.js';
import { TaxTotals } from './TaxTotals.js';

/** The s.34(2) window, the actions it still allows, and the invoice's notes. */
function Adjustments({
  invoice,
  adjustments,
}: {
  readonly invoice: TaxDocumentView;
  readonly adjustments: InvoiceAdjustments;
}) {
  const { t, plural, date } = useI18n();
  const can = usePermissions();
  const window = adjustments.creditNoteWindow;
  const creditOpen = window !== null && window.status !== 'closed';
  // A composition store's bill of supply carries no tax to raise.
  const kinds: NoteKind[] = [
    ...(creditOpen ? (['credit_note'] as const) : []),
    ...(window !== null && invoice.kind === 'invoice' ? (['debit_note'] as const) : []),
  ];
  const actions = can(NOTES_PERMISSION) ? (
    <div className="row">
      {creditOpen && <ReturnDialog invoice={invoice} adjustments={adjustments} />}
      {kinds.length > 0 && <NoteDialog invoice={invoice} kinds={kinds} />}
    </div>
  ) : undefined;
  return (
    <Card title={t('sales.adjust.title')} actions={actions}>
      <div className="stack">
        {window?.status === 'open' && (
          <p className="cell-meta">{t('sales.adjust.open', { date: date(window.deadline) })}</p>
        )}
        {window?.status === 'closing' && (
          <Alert tone="warning">
            {plural('sales.adjust.closing', window.daysLeft, { date: date(window.deadline) })}
          </Alert>
        )}
        {window?.status === 'closed' && (
          <Alert tone="info">{t('sales.adjust.closed', { date: date(window.deadline) })}</Alert>
        )}
        {adjustments.notes.length === 0 ? (
          <p>{t('sales.adjust.empty')}</p>
        ) : (
          <NotesTable notes={adjustments.notes} title={t('sales.adjust.title')} />
        )}
      </div>
    </Card>
  );
}

function InvoiceDetail({ invoice }: { readonly invoice: TaxDocumentView }) {
  const api = useApi();
  const { t, label, date } = useI18n();
  const adjustments = useQuery({
    queryKey: ['invoices', invoice.id, 'adjustments'],
    queryFn: ({ signal }) => api.sales.adjustments(invoice.id, signal),
  });
  const facts: [string, string][] = [
    [
      t('sales.invoice.issuedOn'),
      invoice.issuedOn === null ? t('common.none') : date(invoice.issuedOn),
    ],
    [t('sales.invoice.buyer'), invoice.buyer.name ?? t('common.none')],
    [t('sales.invoice.gstin'), invoice.buyer.gstin ?? t('common.none')],
    [t('sales.invoice.placeOfSupply'), invoice.placeOfSupplyCode ?? t('common.none')],
    [
      t('sales.invoice.supply'),
      invoice.supplyType === null ? t('common.none') : label('supplyTypes', invoice.supplyType),
    ],
  ];
  if (invoice.cancelReason !== null) {
    facts.push([t('sales.invoice.cancelReason'), invoice.cancelReason]);
  }
  return (
    <>
      <PageHeader
        title={
          invoice.number === null
            ? t('sales.invoice.draftTitle')
            : t('sales.invoice.title', { number: invoice.number })
        }
        description={label('taxDocumentKinds', invoice.kind)}
      />
      <Card
        title={t('sales.invoice.details')}
        actions={
          <Badge tone={STATUS_TONE[invoice.status]}>
            {label('taxDocumentStatuses', invoice.status)}
          </Badge>
        }
      >
        <dl className="facts">
          {facts.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title={t('sales.lines.title')}>
        <div className="stack">
          <LinesTable lines={invoice.lines} />
          <TaxTotals totals={invoice} />
        </div>
      </Card>
      <QueryState query={adjustments} error="sales.adjust.error">
        {(data) => <Adjustments invoice={invoice} adjustments={data} />}
      </QueryState>
    </>
  );
}

/** /invoices/:id — one invoice, read-only, with its returns and credit / debit notes. */
export function InvoicePage() {
  const api = useApi();
  // The route always has an :id.
  const id = String(useParams().id);
  const invoice = useQuery({
    queryKey: ['invoices', id],
    queryFn: ({ signal }) => api.sales.invoice(id, signal),
  });
  return (
    <QueryState query={invoice} error="sales.invoice.error">
      {(data) => <InvoiceDetail invoice={data} />}
    </QueryState>
  );
}
