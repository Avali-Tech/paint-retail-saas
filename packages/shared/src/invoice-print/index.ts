/**
 * Invoice print (MVP 2 round 2b): the engine's `Invoice` plus the document's header
 * data become a print-ready `InvoiceView` (`buildInvoiceView`), which decides the
 * Rule 46 fields each case needs. The web app's A4 and thermal templates, the
 * fixed-width thermal text and the API's PDF all render only that view.
 * See docs/mvp-2/print.md.
 */
export {
  addressLines,
  formatAmount,
  formatPrintDate,
  formatQuantity,
  formatRate,
  stateLabel,
} from './format.js';
export {
  INVOICE_LABEL_KEYS,
  INVOICE_LABELS,
  LEGAL_TEXTS,
  fillLabel,
  invoiceLabels,
  type InvoiceLabelKey,
  type InvoiceLabelSet,
  type InvoiceLabels,
  type PrintLabel,
  type PrintLanguage,
  type SecondLanguage,
} from './labels.js';
export { sampleInvoice, sampleInvoiceView, type SampleInvoiceOptions } from './sample.js';
export { THERMAL_COLUMNS, renderThermalText, wrapText } from './thermal-text.js';
export type * from './types.js';
export {
  B2C_LARGE_ABOVE_PAISE,
  InvoicePrintError,
  UNREGISTERED_DETAILS_FROM_PAISE,
  buildInvoiceView,
  printIssues,
  printRequirements,
  type InvoicePrintErrorCode,
} from './view-model.js';
