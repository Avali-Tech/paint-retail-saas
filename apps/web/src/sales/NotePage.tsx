import { Alert, Card, PageHeader } from '@paint/ui';
import type { NoteView } from '@paint/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { usePageLanding } from './focus-landing.js';
import { LinesTable } from './LinesTable.js';
import { TaxTotals } from './TaxTotals.js';

function NoteDetail({ note }: { readonly note: NoteView }) {
  const { t, label, date } = useI18n();
  usePageLanding(true, note);
  const facts: [string, string][] = [
    [t('sales.note.reason'), label('noteReasons', note.reason)],
    [t('sales.note.issuedOn'), date(String(note.issuedOn))],
    [t('sales.note.buyer'), note.buyer.name ?? t('common.none')],
  ];
  if (note.itcReversalStatus !== null) {
    facts.push([t('sales.note.itc'), label('itcReversalStatuses', note.itcReversalStatus)]);
  }
  if (note.schemeReference !== null) {
    facts.push([t('sales.note.scheme'), note.schemeReference]);
  }
  if (note.note !== null) facts.push([t('sales.note.note'), note.note]);
  return (
    <>
      <PageHeader
        title={t('sales.note.title', {
          kind: label('taxDocumentKinds', note.kind),
          number: String(note.number),
        })}
        description={
          <>
            {t('sales.note.invoice')}{' '}
            <Link to={`/invoices/${note.invoice.id}`}>{note.invoice.number}</Link>
          </>
        }
      />
      <Card title={t('sales.note.details')}>
        <div className="stack">
          {note.itcReversalStatus === 'unknown' && (
            <Alert tone="info">{t('sales.note.itcUnknown')}</Alert>
          )}
          <dl className="facts">
            {facts.map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Card>
      <Card title={t('sales.lines.title')}>
        <div className="stack">
          <LinesTable lines={note.lines} />
          <TaxTotals totals={note} />
        </div>
      </Card>
    </>
  );
}

/** /notes/:id — one credit or debit note, where a return or a note leads. */
export function NotePage() {
  const api = useApi();
  // The route always has an :id.
  const id = String(useParams().id);
  const note = useQuery({
    queryKey: ['notes', 'one', id],
    queryFn: ({ signal }) => api.sales.note(id, signal),
  });
  return (
    <QueryState query={note} error="sales.note.error">
      {(data) => <NoteDetail note={data} />}
    </QueryState>
  );
}
