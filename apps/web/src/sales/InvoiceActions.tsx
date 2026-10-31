import { Alert, Button, Field, Textarea, useToast } from '@paint/ui';
import type { TaxDocumentView } from '@paint/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { saveFile } from '../lib/download.js';
import { FormDialog } from '../lib/FormDialog.js';
import { todayInIndia } from '../lib/india-time.js';
import { PrintSlot, type PrintFormat, type PrintJob } from '../pos/PosPrint.js';
import { refreshSales } from './refresh.js';

/** "Cancel invoice": same day only, before notes, dispatch or payments; else a credit note. */
function CancelDialog({
  invoice,
  onClose,
}: {
  readonly invoice: TaxDocumentView;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, date } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [today] = useState(todayInIndia);
  const number = String(invoice.number);
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('sales.cancel.title', { number })}
      description={t('sales.cancel.rules')}
      submitLabel={t('sales.cancel.submit')}
      onSubmit={async () => {
        if (reason.trim().length < 3) return t('sales.cancel.reasonInvalid');
        await api.sales.cancelInvoice(invoice.id, reason.trim());
        await refreshSales(queryClient);
        toast({ title: t('sales.cancel.done', { number }), tone: 'success' });
        return undefined;
      }}
    >
      {invoice.issuedOn !== today && (
        <Alert tone="warning">
          {t('sales.cancel.notToday', { date: date(String(invoice.issuedOn)) })}
        </Alert>
      )}
      <Field label={t('sales.cancel.reason')} required>
        <Textarea
          maxLength={500}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

/**
 * Reprint (A4 or the 80 mm counter printer), the A4 PDF, and cancel, for an issued
 * invoice: printed with the counter's templates and the business's settings today.
 */
export function InvoiceActions({ invoice }: { readonly invoice: TaxDocumentView }) {
  const api = useApi();
  const { t, locale } = useI18n();
  const can = usePermissions();
  const [job, setJob] = useState<PrintJob | null>(null);
  const [pending, setPending] = useState<PrintFormat | 'pdf' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const prints = useRef(0);

  const run = (kind: PrintFormat | 'pdf', action: () => Promise<void>) => {
    setPending(kind);
    setMessage(null);
    action()
      .catch((error: unknown) => {
        setMessage(errorMessage(error));
      })
      .finally(() => {
        setPending(null);
      });
  };
  const print = (format: PrintFormat) => {
    run(format, async () => {
      const printable = await api.sales.printable(invoice.id);
      prints.current += 1;
      setJob({ id: prints.current, invoice: printable, format });
    });
  };

  return (
    <div className="stack">
      <div className="row">
        <Button
          variant="secondary"
          loading={pending === 'a4'}
          onClick={() => {
            print('a4');
          }}
        >
          {t('sales.reprint.a4')}
        </Button>
        <Button
          variant="secondary"
          loading={pending === 'thermal'}
          onClick={() => {
            print('thermal');
          }}
        >
          {t('sales.reprint.thermal')}
        </Button>
        <Button
          variant="secondary"
          loading={pending === 'pdf'}
          onClick={() => {
            run('pdf', async () => {
              const file = await api.sales.invoicePdf(invoice.id, locale);
              saveFile(file.blob, file.fileName ?? `${String(invoice.number)}.pdf`);
            });
          }}
        >
          {t('sales.reprint.pdf')}
        </Button>
        {can('billing:cancel') && (
          <Button
            variant="danger"
            onClick={() => {
              setCancelling(true);
            }}
          >
            {t('sales.cancel.open')}
          </Button>
        )}
      </div>
      {message !== null && <Alert tone="danger">{message}</Alert>}
      {cancelling && (
        <CancelDialog
          invoice={invoice}
          onClose={() => {
            setCancelling(false);
          }}
        />
      )}
      <PrintSlot job={job} />
    </div>
  );
}
