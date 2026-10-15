/**
 * Receivables (roadmap P2-M10) and customer statements (P2-M12): a pure ageing
 * engine over what parties owe and have paid ahead, and the statement's print view
 * model. No IO: the API loads the rows, the web app and the PDF render the views.
 */
export {
  AGEING_BUCKETS,
  DUE_SOON_DAYS,
  ageReceivables,
  bucketFor,
  creditUtilisation,
  dueSummary,
  emptyTotals,
  groupAgeing,
  outstandingOn,
  sumTotals,
  unappliedOn,
  type AgedReceivable,
  type AgeingBucket,
  type AgeingResult,
  type AgeingTotals,
  type Credit,
  type CreditKind,
  type CreditLine,
  type CreditUtilisation,
  type DatedAmount,
  type DueSummary,
  type Receivable,
  type ReceivableKind,
  type UnappliedCredit,
} from './ageing.js';
export { addDays, dayNumber, daysBetween } from './dates.js';
export {
  AGEING_GROUPS,
  RECEIVABLES_PERMISSION,
  STATEMENT_MAX_ENTRIES,
  STATEMENT_PERMISSION,
  type AgeingGroup,
  type AgeingPage,
  type AgeingQuery,
  type AgeingRowView,
  type OpenItemView,
  type ReceivablesQuery,
  type ReceivablesSummaryView,
  type StatementData,
  type StatementEntryView,
  type StatementQuery,
  type TopCustomerView,
} from './api.js';
export {
  STATEMENT_LINK_DAYS,
  STATEMENT_TOKEN_PATTERN,
  type ShareStatementBody,
  type StatementLinkStatus,
  type StatementLinkView,
  type StatementShareResult,
} from './links.js';
export {
  STATEMENT_LABEL_KEYS,
  STATEMENT_LABELS,
  statementLabels,
  type StatementLabelKey,
  type StatementLabels,
} from './statement-labels.js';
export {
  buildStatementView,
  statementFileName,
  statementShareText,
  type StatementAgeingRow,
  type StatementOpenItemRow,
  type StatementRow,
  type StatementView,
} from './statement-view.js';
