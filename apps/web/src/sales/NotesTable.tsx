import { Table } from '@paint/ui';
import type { NoteSummary } from '@paint/shared';
import { Link } from 'react-router';
import { useI18n } from '../i18n/i18n.js';

/** Credit and debit notes as rows, each linking to the note and its invoice. */
export function NotesTable({
  notes,
  title,
}: {
  readonly notes: readonly NoteSummary[];
  readonly title: string;
}) {
  const { t, label, money, date } = useI18n();
  return (
    <Table label={title}>
      <thead>
        <tr>
          <th scope="col">{t('sales.notes.number')}</th>
          <th scope="col">{t('sales.notes.reason')}</th>
          <th scope="col">{t('sales.notes.invoice')}</th>
          <th scope="col">{t('sales.notes.date')}</th>
          <th scope="col">{t('sales.notes.buyer')}</th>
          <th scope="col">{t('sales.notes.total')}</th>
        </tr>
      </thead>
      <tbody>
        {notes.map((note) => (
          <tr key={note.id}>
            <th scope="row">
              <Link to={`/notes/${note.id}`}>{note.number}</Link>
              <span className="cell-meta">{label('taxDocumentKinds', note.kind)}</span>
            </th>
            <td>{label('noteReasons', note.reason)}</td>
            <td>
              <Link to={`/invoices/${note.invoice.id}`}>{note.invoice.number}</Link>
            </td>
            <td>{date(String(note.issuedOn))}</td>
            <td>{note.buyerName ?? t('common.none')}</td>
            <td>{money(note.totalPaise)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
