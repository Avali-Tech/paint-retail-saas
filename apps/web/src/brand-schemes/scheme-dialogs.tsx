import {
  BENEFIT_MONEY_FORMS,
  BRAND_CLAIM_STATUSES,
  type BenefitReceiptInput,
  type BrandClaimView,
  type SchemeDetail,
} from '@paint/shared';
import { Field, Input, Select, Textarea, useToast } from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { optional, parseRupees } from '../lib/inputs.js';
import { todayInIndia } from '../lib/india-time.js';
import type { ClaimUpdate } from './schemes-api.js';
import { schemesKey } from './scheme-parts.js';

// The scheme detail's dialogs: what the brand issued, a claim filed with the brand,
// following a claim up, and closing or cancelling the scheme.

type ReceiptKind = BenefitReceiptInput['kind'];
const RECEIPT_KINDS: readonly ReceiptKind[] = ['money', 'free_goods', 'points'];
const CLAIM_UPDATES = BRAND_CLAIM_STATUSES.filter(
  (status): status is ClaimUpdate['status'] => status !== 'filed',
);
const SIGNED_WHOLE = /^-?\d+$/;

/** Records a credit note, payment, free goods or points against the scheme. */
export function ReceiptDialog({
  detail,
  packs,
  onClose,
}: {
  readonly detail: SchemeDetail;
  readonly packs: readonly { readonly id: string; readonly title: string }[];
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [key] = useState(() => crypto.randomUUID());
  const [values, setValues] = useState({
    kind: 'money' as ReceiptKind,
    receivedOn: todayInIndia(),
    amount: '',
    moneyForm: 'credit_note' as (typeof BENEFIT_MONEY_FORMS)[number],
    variantId: '',
    units: '1',
    label: '',
    points: '1',
    reference: '',
    note: '',
    claimId: '',
  });
  const text = (field: keyof typeof values) => ({
    value: values[field],
    onChange: (event: { target: { value: string } }) => {
      setValues((current) => ({ ...current, [field]: event.target.value }));
    },
  });
  const read = (): BenefitReceiptInput | string => {
    const base = {
      receivedOn: values.receivedOn,
      reference: optional(values.reference),
      note: optional(values.note),
      claimId: values.claimId === '' ? null : values.claimId,
    };
    switch (values.kind) {
      case 'money': {
        const negative = values.amount.trim().startsWith('-');
        const paise = parseRupees(values.amount.trim().replace(/^-/, ''));
        if (paise === null || paise === 0) return t('schemes.receipt.invalidAmount');
        return {
          kind: 'money',
          amountPaise: negative ? -paise : paise,
          moneyForm: values.moneyForm,
          ...base,
        };
      }
      case 'free_goods':
        if (values.variantId === '') return t('schemes.invalid.variant');
        if (!SIGNED_WHOLE.test(values.units.trim()) || Number(values.units) === 0) {
          return t('schemes.invalid.units');
        }
        return {
          kind: 'free_goods',
          variantId: values.variantId,
          units: Number(values.units),
          goodsReceiptId: null,
          ...base,
        };
      case 'points':
        if (values.label.trim() === '') return t('schemes.invalid.label');
        if (!SIGNED_WHOLE.test(values.points.trim()) || Number(values.points) === 0) {
          return t('schemes.invalid.points');
        }
        return {
          kind: 'points',
          label: values.label.trim(),
          points: Number(values.points),
          ...base,
        };
    }
  };
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('schemes.receipt.title')}
      description={t('schemes.receipt.hint')}
      submitLabel={t('schemes.receipt.save')}
      onSubmit={async () => {
        const input = read();
        if (typeof input === 'string') return input;
        await api.schemes.recordReceipt(detail.scheme.id, input, key);
        await queryClient.invalidateQueries({ queryKey: schemesKey });
        toast({ title: t('schemes.receipt.saved'), tone: 'success' });
        return undefined;
      }}
    >
      <Field label={t('schemes.receipt.kind')}>
        <Select {...text('kind')}>
          {RECEIPT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {label('schemeReceiptKind', kind)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('schemes.receipt.receivedOn')}>
        <Input type="date" {...text('receivedOn')} />
      </Field>
      {values.kind === 'money' && (
        <div className="form-grid">
          <Field label={t('schemes.receipt.amount')} hint={t('schemes.receipt.amountHint')}>
            <Input inputMode="decimal" {...text('amount')} />
          </Field>
          <Field label={t('schemes.receipt.moneyForm')}>
            <Select {...text('moneyForm')}>
              {BENEFIT_MONEY_FORMS.map((form) => (
                <option key={form} value={form}>
                  {label('schemeMoneyForm', form)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      {values.kind === 'free_goods' && (
        <div className="form-grid">
          <Field label={t('schemes.receipt.pack')}>
            <Select {...text('variantId')}>
              <option value="">{t('schemes.editor.choosePack')}</option>
              {packs.map((pack) => (
                <option key={pack.id} value={pack.id}>
                  {pack.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('schemes.receipt.units')}>
            <Input inputMode="numeric" {...text('units')} />
          </Field>
        </div>
      )}
      {values.kind === 'points' && (
        <div className="form-grid">
          <Field label={t('schemes.receipt.label')}>
            <Input {...text('label')} />
          </Field>
          <Field label={t('schemes.receipt.points')}>
            <Input inputMode="numeric" {...text('points')} />
          </Field>
        </div>
      )}
      <Field label={t('schemes.receipt.reference')}>
        <Input maxLength={60} {...text('reference')} />
      </Field>
      {detail.claims.length > 0 && (
        <Field label={t('schemes.receipt.claim')}>
          <Select {...text('claimId')}>
            <option value="">{t('schemes.receipt.noClaim')}</option>
            {detail.claims.map((claim) => (
              <option key={claim.id} value={claim.id}>
                {claim.number}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={t('schemes.receipt.note')}>
        <Textarea maxLength={500} {...text('note')} />
      </Field>
    </FormDialog>
  );
}

/** Files a claim with the brand: by default for what is still owed. */
export function ClaimDialog({
  detail,
  onClose,
}: {
  readonly detail: SchemeDetail;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, money } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [values, setValues] = useState({
    filedOn: todayInIndia(),
    amount: '',
    brandReference: '',
    note: '',
  });
  const text = (field: keyof typeof values) => ({
    value: values[field],
    onChange: (event: { target: { value: string } }) => {
      setValues((current) => ({ ...current, [field]: event.target.value }));
    },
  });
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('schemes.claim.title')}
      submitLabel={t('schemes.claim.save')}
      onSubmit={async () => {
        const amount = values.amount.trim() === '' ? undefined : parseRupees(values.amount);
        if (amount === null) return t('schemes.claim.invalidAmount');
        await api.schemes.fileClaim(detail.scheme.id, {
          filedOn: values.filedOn,
          ...(amount === undefined ? {} : { claimedPaise: amount }),
          brandReference: optional(values.brandReference),
          note: optional(values.note),
        });
        await queryClient.invalidateQueries({ queryKey: schemesKey });
        toast({ title: t('schemes.claim.saved'), tone: 'success' });
        return undefined;
      }}
    >
      <Field label={t('schemes.claim.filedOn')}>
        <Input type="date" {...text('filedOn')} />
      </Field>
      <Field
        label={t('schemes.claim.amount')}
        hint={t('schemes.claim.amountHint', {
          amount: money(Math.max(detail.claim.money.outstandingPaise, 0)),
        })}
      >
        <Input inputMode="decimal" {...text('amount')} />
      </Field>
      <Field label={t('schemes.claim.brandReference')}>
        <Input maxLength={60} {...text('brandReference')} />
      </Field>
      <Field label={t('schemes.claim.note')}>
        <Textarea maxLength={500} {...text('note')} />
      </Field>
    </FormDialog>
  );
}

/** Moves a claim on: acknowledged, settled, rejected or withdrawn. */
export function ClaimStatusDialog({
  claim,
  onClose,
}: {
  readonly claim: BrandClaimView;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ClaimUpdate['status']>('acknowledged');
  const [brandReference, setBrandReference] = useState(claim.brandReference ?? '');
  const [note, setNote] = useState('');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('schemes.claim.updateTitle', { number: claim.number })}
      submitLabel={t('common.save')}
      onSubmit={async () => {
        await api.schemes.updateClaim(claim.id, {
          status,
          brandReference: optional(brandReference),
          note: optional(note),
        });
        await queryClient.invalidateQueries({ queryKey: schemesKey });
        toast({ title: t('schemes.claim.updated'), tone: 'success' });
        return undefined;
      }}
    >
      <Field label={t('schemes.claim.status')}>
        <Select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as ClaimUpdate['status']);
          }}
        >
          {CLAIM_UPDATES.map((value) => (
            <option key={value} value={value}>
              {label('brandClaimStatus', value)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('schemes.claim.brandReference')}>
        <Input
          maxLength={60}
          value={brandReference}
          onChange={(event) => {
            setBrandReference(event.target.value);
          }}
        />
      </Field>
      <Field label={t('schemes.claim.note')}>
        <Textarea
          maxLength={500}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

/** Closes (nothing more expected) or cancels (withdrawn) the scheme, with a note. */
export function EndDialog({
  detail,
  action,
  onClose,
}: {
  readonly detail: SchemeDetail;
  readonly action: 'close' | 'cancel';
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t(action === 'close' ? 'schemes.end.closeTitle' : 'schemes.end.cancelTitle')}
      description={t(action === 'close' ? 'schemes.end.closeHint' : 'schemes.end.cancelHint')}
      submitLabel={t(action === 'close' ? 'schemes.end.close' : 'schemes.end.cancel')}
      onSubmit={async () => {
        await (action === 'close'
          ? api.schemes.close(detail.scheme.id, optional(note))
          : api.schemes.cancel(detail.scheme.id, optional(note)));
        await queryClient.invalidateQueries({ queryKey: schemesKey });
        toast({ title: t('schemes.end.done'), tone: 'success' });
        return undefined;
      }}
    >
      <Field label={t('schemes.end.note')}>
        <Textarea
          maxLength={500}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}
