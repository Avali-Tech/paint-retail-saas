import { SectionNav, type SectionLink } from '../lib/SectionNav.js';

/** The export and the ledger mappings it uses, linked from each other. */
const ACCOUNTING_SECTIONS: readonly SectionLink[] = [
  { to: '/accounting/export', label: 'books.accounting.export', permission: 'accounting:export' },
  { to: '/accounting/ledgers', label: 'books.accounting.ledgers', permission: 'accounting:export' },
];

export function AccountingNav() {
  return <SectionNav label="books.accounting.sections" links={ACCOUNTING_SECTIONS} />;
}
