import type { PaymentInstructions, SubscriptionInvoiceView } from '@paint/shared';
import { Badge, Card } from '@paint/ui';
import { useI18n } from '../i18n/i18n.js';
import { Facts } from '../leads/Facts.js';

/** Paid (when), or the day it is payable by. */
export function InvoiceStatus({ invoice }: { readonly invoice: SubscriptionInvoiceView }) {
  const { t, date } = useI18n();
  return invoice.payment === null ? (
    <Badge tone="warning">{t('subscription.unpaid', { date: date(invoice.dueOn) })}</Badge>
  ) : (
    <Badge tone="success">{t('subscription.paid', { date: date(invoice.payment.paidOn) })}</Badge>
  );
}

/** Where to send money for our invoices, with manual invoicing. */
export function PaymentInstructionsCard({
  instructions,
}: {
  readonly instructions: PaymentInstructions;
}) {
  const { t } = useI18n();
  return (
    <Card title={t('subscription.payTitle')}>
      <div className="stack">
        <p className="muted">{t('subscription.payHint')}</p>
        <Facts
          facts={[
            [t('subscription.accountName'), instructions.accountName],
            [t('subscription.bankName'), instructions.bankName],
            [t('subscription.accountNumber'), instructions.accountNumber],
            [t('subscription.ifsc'), instructions.ifsc],
            [t('subscription.upiId'), instructions.upiId],
          ]}
        />
      </div>
    </Card>
  );
}
