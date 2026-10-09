import type { IssuedInvoiceView } from '@paint/shared';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n/i18n.js';
import { InvoiceA4 } from '../print/InvoiceA4.js';
import { InvoiceThermal } from '../print/InvoiceThermal.js';
import '../print/print.css';
import { useIdentity } from '../theme/IdentityProvider.js';
import { printViewOf } from './print-view.js';

// Printing at the counter (spec §5.2 step 5, §5.4): the issued bill is rendered with
// round 2b's templates into a print-only layer, under the business's logo and with
// the settings the issue returned (bank, terms, turnover), and the print dialog opens.

export type PrintFormat = 'thermal' | 'a4';

/** One request to print: a new `id` prints again. */
export interface PrintJob {
  readonly id: number;
  readonly invoice: IssuedInvoiceView;
  readonly format: PrintFormat;
}

/** The print layer: renders the job, then opens the print dialog. */
export function PrintSlot({ job }: { readonly job: PrintJob | null }) {
  const { locale } = useI18n();
  const { logoSrc } = useIdentity();
  useEffect(() => {
    if (job !== null) window.print();
  }, [job]);
  if (job === null) return null;
  // Labels in the member's language too; legal headings stay in English (§5.4).
  const view = printViewOf(job.invoice, locale === 'en' ? null : locale, logoSrc);
  return createPortal(
    <div className="pos-print" data-testid="print-layer" data-format={job.format}>
      {job.format === 'thermal' ? <InvoiceThermal view={view} /> : <InvoiceA4 view={view} />}
    </div>,
    document.body,
  );
}
