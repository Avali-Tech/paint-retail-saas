import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  Field,
  Input,
  Select,
  buttonStyle,
  useToast,
  type Tone,
} from '@paint/ui';
import {
  PAYMENT_LINK_MANAGE_PERMISSION,
  STAFF_LINK_PURPOSES,
  type PaymentLinkCreated,
  type PaymentLinkStatus,
  type PaymentLinkSummary,
  type StaffLinkPurpose,
} from '@paint/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { parseRupees } from '../lib/inputs.js';

export const LINK_STATUS_TONE: Readonly<Record<PaymentLinkStatus, Tone>> = {
  created: 'primary',
  paid: 'success',
  expired: 'warning',
  cancelled: 'neutral',
};

/** Whether this server makes payment links (PAYMENT_LINK_PROVIDER), and whether the member may send one. */
export function usePaymentLinks(): { readonly on: boolean; readonly canSend: boolean } {
  const api = useApi();
  const can = usePermissions();
  const settings = useQuery({
    queryKey: ['payment-link-settings'],
    queryFn: ({ signal }) => api.paymentLinks.settings(signal),
  });
  const on = (settings.data?.provider ?? null) !== null;
  return { on, canSend: on && can(PAYMENT_LINK_MANAGE_PERMISSION) };
}

/** A link's status as shown: an open link with money on it reads "part paid". */
export function LinkStatus({ link }: { readonly link: PaymentLinkSummary }) {
  const { t, label } = useI18n();
  return link.status === 'created' && link.paidPaise > 0 ? (
    <Badge tone="warning">{t('paymentLinks.partPaid')}</Badge>
  ) : (
    <Badge tone={LINK_STATUS_TONE[link.status]}>{label('paymentLinkStatus', link.status)}</Badge>
  );
}

/** Copies a link to the clipboard, to paste into a message by hand. */
export function CopyLinkButton({ link }: { readonly link: { number: string; url: string } }) {
  const { t } = useI18n();
  const toast = useToast();
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={t('paymentLinks.copyName', { number: link.number })}
      onClick={() => {
        void navigator.clipboard.writeText(link.url).then(() => {
          toast({ title: t('paymentLinks.copied'), tone: 'success' });
        });
      }}
    >
      {t('paymentLinks.copy')}
    </Button>
  );
}

/** The link just made: where to pay, WhatsApp to share it, and whether the message went. */
function LinkCreatedDialog({
  created,
  onClose,
}: {
  readonly created: PaymentLinkCreated;
  readonly onClose: () => void;
}) {
  const { t, money, dateTime } = useI18n();
  const { link, message, waMeUrl } = created;
  return (
    <Dialog
      open
      onOpenChange={onClose}
      title={t('paymentLinks.result.title', { number: link.number })}
      description={t('paymentLinks.result.summary', {
        amount: money(link.amountPaise),
        date: dateTime(link.expiresAt),
      })}
      closeLabel={t('common.close')}
    >
      <div className="stack">
        {message !== null &&
          (message.queued ? (
            <Alert tone="success">{t('paymentLinks.result.sent')}</Alert>
          ) : (
            <Alert tone="warning">{t(`paymentLinks.result.notSent.${message.reason}`)}</Alert>
          ))}
        <code className="break-all">{link.url}</code>
        <div className="row row--end">
          <CopyLinkButton link={link} />
          {waMeUrl !== null && (
            <a {...buttonStyle('secondary')} href={waMeUrl} target="_blank" rel="noreferrer">
              {t('paymentLinks.result.whatsapp')}
            </a>
          )}
          <Button onClick={onClose}>{t('paymentLinks.result.done')}</Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Asks a customer for money by UPI link (P2-M32): an invoice's outstanding, or the
 * overdue bills, everything owed or an advance; the server works out the amount and
 * refuses what cannot be asked for. With WhatsApp set up it can also send it.
 */
export function SendPaymentLinkDialog({
  party,
  invoice,
  onClose,
}: {
  readonly party: { readonly id: string; readonly name: string };
  readonly invoice?: { readonly id: string; readonly number: string } | undefined;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, label } = useI18n();
  const queryClient = useQueryClient();
  const [key] = useState(() => crypto.randomUUID());
  const [purpose, setPurpose] = useState<StaffLinkPurpose>(invoice ? 'invoice' : 'overdue');
  const [amount, setAmount] = useState('');
  const [whatsapp, setWhatsapp] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [created, setCreated] = useState<PaymentLinkCreated | null>(null);
  const messaging = useQuery({
    queryKey: ['messaging-status'],
    queryFn: ({ signal }) => api.messaging.status(signal),
  });
  if (created !== null) return <LinkCreatedDialog created={created} onClose={onClose} />;
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('paymentLinks.dialog.title')}
      description={t('paymentLinks.dialog.description')}
      submitLabel={t('paymentLinks.dialog.create')}
      onSubmit={async (): Promise<false> => {
        const amountPaise = amount.trim() === '' ? undefined : parseRupees(amount);
        if (
          amountPaise === null ||
          (amountPaise !== undefined && amountPaise <= 0) ||
          (purpose === 'advance' && amountPaise === undefined)
        ) {
          setError(t('paymentLinks.dialog.amountInvalid'));
          return false;
        }
        setError(undefined);
        const result = await api.paymentLinks.create(
          {
            partyId: party.id,
            purpose,
            ...(invoice === undefined ? {} : { invoiceId: invoice.id }),
            ...(amountPaise === undefined ? {} : { amountPaise }),
            ...(whatsapp ? { send: 'whatsapp' as const } : {}),
          },
          key,
        );
        await queryClient.invalidateQueries({ queryKey: ['payment-links'] });
        setCreated(result);
        return false;
      }}
    >
      {invoice === undefined ? (
        <Field label={t('paymentLinks.dialog.purpose')}>
          <Select
            value={purpose}
            onChange={(event) => {
              setPurpose(event.target.value as StaffLinkPurpose);
            }}
          >
            {STAFF_LINK_PURPOSES.filter((value) => value !== 'invoice').map((value) => (
              <option key={value} value={value}>
                {label('paymentLinkPurpose', value)}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <p>{t('paymentLinks.dialog.invoice', { number: invoice.number })}</p>
      )}
      <Field
        label={t('paymentLinks.dialog.amount')}
        hint={
          purpose === 'advance'
            ? t('paymentLinks.dialog.amountAdvanceHint')
            : t('paymentLinks.dialog.amountHint')
        }
        required={purpose === 'advance'}
        error={error}
      >
        <Input
          inputMode="decimal"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
          }}
        />
      </Field>
      {(messaging.data?.whatsapp ?? null) !== null && (
        <Checkbox
          label={t('paymentLinks.dialog.whatsapp')}
          checked={whatsapp}
          onChange={(event) => {
            setWhatsapp(event.target.checked);
          }}
        />
      )}
    </FormDialog>
  );
}

/** "Send payment link", for members who take payments, when this server makes links. */
export function SendPaymentLinkButton({
  party,
  invoice,
  size,
}: {
  readonly party: { readonly id: string; readonly name: string };
  readonly invoice?: { readonly id: string; readonly number: string } | undefined;
  readonly size?: 'sm';
}) {
  const { t } = useI18n();
  const { canSend } = usePaymentLinks();
  const [open, setOpen] = useState(false);
  if (!canSend) return null;
  return (
    <>
      <Button
        variant="secondary"
        {...(size === undefined ? {} : { size })}
        aria-label={t('paymentLinks.sendName', { name: party.name })}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t('paymentLinks.send')}
      </Button>
      {open && (
        <SendPaymentLinkDialog
          party={party}
          invoice={invoice}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

/** Cancels an open link, so it can no longer be paid. */
function CancelLinkButton({ link }: { readonly link: PaymentLinkSummary }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={t('paymentLinks.cancelName', { number: link.number })}
      onClick={() => {
        void api.paymentLinks
          .cancel(link.id)
          .then(async () => {
            await queryClient.invalidateQueries({ queryKey: ['payment-links'] });
            toast({ title: t('paymentLinks.cancelled'), tone: 'success' });
          })
          .catch((error: unknown) => {
            toast({ title: errorMessage(error), tone: 'danger' });
          });
      }}
    >
      {t('paymentLinks.cancel')}
    </Button>
  );
}

/** One link in a list: what it asks, its status, and copy / cancel while open. */
export function LinkActions({ link }: { readonly link: PaymentLinkSummary }) {
  const can = usePermissions();
  if (link.status !== 'created') return null;
  return (
    <span className="row">
      <CopyLinkButton link={link} />
      {can(PAYMENT_LINK_MANAGE_PERMISSION) && <CancelLinkButton link={link} />}
    </span>
  );
}

/**
 * The payment links of a customer, or of one invoice, on its page: the latest five with
 * their status, and sending a new one. Shown only when this server makes links.
 */
export function PaymentLinksPanel({
  party,
  invoice,
}: {
  readonly party: { readonly id: string; readonly name: string };
  readonly invoice?: { readonly id: string; readonly number: string } | undefined;
}) {
  const api = useApi();
  const { t, label, money, dateTime } = useI18n();
  const { on } = usePaymentLinks();
  const filters = {
    ...(invoice === undefined ? { partyId: party.id } : { invoiceId: invoice.id }),
    limit: 5,
    offset: 0,
  };
  const links = useQuery({
    queryKey: ['payment-links', filters],
    queryFn: ({ signal }) => api.paymentLinks.list(filters, signal),
    enabled: on,
  });
  if (!on) return null;
  const items = links.data?.items ?? [];
  return (
    <Card
      title={t('paymentLinks.panelTitle')}
      actions={<SendPaymentLinkButton party={party} invoice={invoice} size="sm" />}
    >
      {links.isError ? (
        <Alert tone="danger">{t('paymentLinks.error')}</Alert>
      ) : items.length === 0 ? (
        <p className="muted">{t('paymentLinks.none')}</p>
      ) : (
        <ul className="record-list">
          {items.map((link) => (
            <li key={link.id}>
              <span className="record-list__title">
                {link.number} · {label('paymentLinkPurpose', link.purpose)} ·{' '}
                {money(link.amountPaise)} <LinkStatus link={link} />
              </span>
              <span className="record-list__meta">
                {link.paidPaise > 0 && `${t('paymentLinks.paid')}: ${money(link.paidPaise)} · `}
                {t('paymentLinks.expires')}: {dateTime(link.expiresAt)}
              </span>
              <LinkActions link={link} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
