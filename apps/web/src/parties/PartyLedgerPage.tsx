import { Card, EmptyState, Field, Icon, Input, PageHeader, Table, buttonStyle } from '@paint/ui';
import type { PartyLedgerEntryView, PartyLedgerView } from '@paint/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { isDate } from '../lib/india-time.js';
import { ListPager, ListRefreshing } from '../lib/ListPager.js';
import { QueryState } from '../lib/QueryState.js';

export const LEDGER_PAGE_SIZE = 50;
const FILTERS = ['from', 'to'] as const;

/** Where an entry's document opens: the invoice, the note, or the payment in the payments list. */
export function referencePath(entry: PartyLedgerEntryView): string | null {
  if (entry.referenceId === null) return null;
  if (entry.referenceType === 'tax_document') {
    const note = entry.entryType === 'credit_note' || entry.entryType === 'debit_note';
    return `/${note ? 'notes' : 'invoices'}/${entry.referenceId}`;
  }
  if (entry.referenceType === 'payment' && entry.referenceNumber !== null) {
    return `/payments?q=${encodeURIComponent(entry.referenceNumber)}`;
  }
  return null;
}

/** A balance the accountant's way: what the party owes is Dr, what they paid ahead is Cr. */
function useBalance() {
  const { t, money } = useI18n();
  return (paise: number) =>
    paise === 0
      ? money(0)
      : paise < 0
        ? t('parties.ledger.cr', { amount: money(-paise) })
        : t('parties.ledger.dr', { amount: money(paise) });
}

function Totals({ page }: { readonly page: PartyLedgerView }) {
  const { t } = useI18n();
  const balance = useBalance();
  const facts: [string, string][] = [
    [t('parties.ledger.opening'), balance(page.openingPaise)],
    [t('parties.ledger.closing'), balance(page.closingPaise)],
    [t('parties.ledger.balanceToday'), balance(page.balancePaise)],
  ];
  if (page.advancePaise > 0) {
    facts.push([t('parties.ledger.advance'), balance(-page.advancePaise)]);
  }
  return (
    <dl className="facts">
      {facts.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Entries({ page }: { readonly page: PartyLedgerView }) {
  const { t, label, money, date } = useI18n();
  const balance = useBalance();
  return (
    <Table label={t('parties.ledger.table')}>
      <thead>
        <tr>
          <th scope="col">{t('parties.ledger.date')}</th>
          <th scope="col">{t('parties.ledger.reference')}</th>
          <th scope="col" className="numeric">
            {t('parties.ledger.debit')}
          </th>
          <th scope="col" className="numeric">
            {t('parties.ledger.credit')}
          </th>
          <th scope="col" className="numeric">
            {t('parties.ledger.balance')}
          </th>
        </tr>
      </thead>
      <tbody>
        {page.entries.map((entry) => {
          const kind = label('partyLedgerEntries', entry.entryType);
          const to = referencePath(entry);
          const name = entry.referenceNumber ?? kind;
          return (
            <tr key={entry.id}>
              <td>{date(entry.entryOn)}</td>
              <th scope="row">
                {to === null ? name : <Link to={to}>{name}</Link>}
                <span className="cell-meta">
                  {[entry.referenceNumber === null ? null : kind, entry.note]
                    .filter((part) => part !== null && part !== name)
                    .join(' · ')}
                </span>
              </th>
              <td className="numeric">{entry.amountPaise > 0 ? money(entry.amountPaise) : ''}</td>
              <td className="numeric">{entry.amountPaise < 0 ? money(-entry.amountPaise) : ''}</td>
              <td className="numeric">{balance(entry.balancePaise)}</td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

/** /parties/:id/ledger — a party's account, a page at a time, with opening and closing balances. */
export function PartyLedgerPage() {
  const api = useApi();
  const { t } = useI18n();
  // The route always has an :id.
  const id = String(useParams().id);
  const filters = useUrlFilters(FILTERS);
  const from = isDate(filters.values.from) ? filters.values.from : undefined;
  const to = isDate(filters.values.to) ? filters.values.to : undefined;
  // The name for the heading; a role without the customer list still sees the ledger.
  const party = useQuery({
    queryKey: ['parties', id],
    queryFn: ({ signal }) => api.parties.get(id, signal),
    retry: false,
  });
  const ledger = useQuery({
    queryKey: ['party-ledger', id, { from, to, offset: filters.offset, cursor: filters.cursor }],
    queryFn: ({ signal }) =>
      api.parties.ledger(
        id,
        { from, to, limit: LEDGER_PAGE_SIZE, offset: filters.offset, cursor: filters.cursor },
        signal,
      ),
    placeholderData: keepPreviousData,
  });
  const name = party.data?.displayName;
  return (
    <>
      <PageHeader
        title={name === undefined ? t('parties.ledger.open') : t('parties.ledger.title', { name })}
        description={t('parties.ledger.description')}
        actions={
          <span className="row">
            <Link to={`/parties/${id}/statement`} {...buttonStyle('secondary')}>
              {t('statement.open')}
            </Link>
            {name !== undefined && (
              <Link to={`/parties/${id}`} {...buttonStyle('secondary')}>
                {t('parties.ledger.back', { name })}
              </Link>
            )}
          </span>
        }
      />
      <Card>
        <div className="stack">
          <div className="filters">
            <Field label={t('parties.ledger.from')}>
              <Input
                type="date"
                value={filters.values.from}
                onChange={(event) => {
                  filters.set('from', event.target.value);
                }}
              />
            </Field>
            <Field label={t('parties.ledger.to')}>
              <Input
                type="date"
                value={filters.values.to}
                onChange={(event) => {
                  filters.set('to', event.target.value);
                }}
              />
            </Field>
            <ListRefreshing query={ledger} />
          </div>
          <QueryState query={ledger} error="parties.ledger.error">
            {(page) => (
              <>
                <Totals page={page} />
                {page.entries.length === 0 ? (
                  <EmptyState
                    icon={<Icon name="search" size={32} />}
                    title={t('parties.ledger.empty')}
                  />
                ) : (
                  <>
                    <Entries page={page} />
                    <ListPager
                      filters={filters}
                      page={{ ...page, items: page.entries }}
                      limit={LEDGER_PAGE_SIZE}
                      label={t('parties.ledger.pages')}
                    />
                  </>
                )}
              </>
            )}
          </QueryState>
        </div>
      </Card>
    </>
  );
}
