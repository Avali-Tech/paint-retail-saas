import { SectionNav, type SectionLink } from '../lib/SectionNav.js';

/** The export, the ledger mappings it uses and the reconciliation, linked from each other. */
const ACCOUNTING_SECTIONS: readonly SectionLink[] = [
  { to: '/accounting/export', label: 'books.accounting.export', permission: 'accounting:export' },
  { to: '/accounting/ledgers', label: 'books.accounting.ledgers', permission: 'accounting:export' },
  {
    to: '/accounting/reconciliation',
    label: 'books.accounting.reconciliation',
    permission: 'accounting:reconcile',
  },
];

export function AccountingNav() {
  return <SectionNav label="books.accounting.sections" links={ACCOUNTING_SECTIONS} />;
}
