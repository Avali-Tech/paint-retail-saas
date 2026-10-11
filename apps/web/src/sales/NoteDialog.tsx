import { Alert, Button, Card, Checkbox, Field, Input, Select, Textarea, useToast } from '@paint/ui';
import {
  VALUE_CREDIT_NOTE_REASONS,
  computeAdjustment,
  noteSourceOf,
  type NoteKind,
  type TaxDocumentView,
  type ValueCreditNoteReason,
} from '@paint/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { parseRupees } from '../lib/inputs.js';
import { refreshSales } from './refresh.js';
import { TaxTotals } from './TaxTotals.js';

/** One typed value: null when left empty, 0 when it is not a positive amount. */
const valueOf = (text: string): number | null => {
  if (text.trim() === '') return null;
  const paise = parseRupees(text);
  return paise !== null && paise > 0 ? paise : 0;
};

/**
 * "Credit / debit note" on an invoice: a discount (under a scheme agreed before
 * the sale), an overcharge or deficient goods lower what was charged; an
 * undercharge raises it. Each value is taxed at the invoice line's rate, previewed
 * by the GST engine. `kinds` are the notes this invoice may still take.
 */
export function NoteDialog({
  invoice,
  kinds,
}: {
  readonly invoice: TaxDocumentView;
  readonly kinds: readonly NoteKind[];
}) {
  const api = useApi();
  const { t, label, money } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const first = kinds.includes('credit_note') ? 'credit_note' : 'debit_note';
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<NoteKind>(first);
  const [reason, setReason] = useState<ValueCreditNoteReason>('discount');
  const [scheme, setScheme] = useState('');
  const [includesTax, setIncludesTax] = useState(invoice.priceMode === 'inclusive');
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const credit = kind === 'credit_note';
  const entries = invoice.lines.map((line) => ({ line, value: valueOf(values[line.id] ?? '') }));
  const valid = entries.flatMap(({ line, value }) =>
    value !== null && value > 0 ? [{ line, valuePaise: value }] : [],
  );
  const preview =
    valid.length === 0
      ? null
      : computeAdjustment(
          noteSourceOf(invoice),
          valid.map(({ line, valuePaise }) => ({ lineIndex: line.lineNo, valuePaise })),
          includesTax,
          true,
        ).totals;

  const submit = async () => {
    const problems: Record<string, string> = {};
    for (const { line, value } of entries) {
      if (value === 0) problems[line.id] = t('sales.noteForm.invalidValue');
    }
    if (credit && reason === 'discount' && scheme.trim() === '') {
      problems.scheme = t('sales.noteForm.schemeRequired');
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return false;
    if (valid.length === 0) return t('sales.noteForm.nothing');
    const body = {
      invoiceId: invoice.id,
      lines: valid.map(({ line, valuePaise }) => ({ invoiceLineId: line.id, valuePaise })),
      valueIncludesTax: includesTax,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    };
    const issued = credit
      ? await api.sales.creditNote({
          ...body,
          reason,
          ...(reason === 'discount' ? { schemeReference: scheme.trim() } : {}),
        })
      : await api.sales.debitNote(body);
    await refreshSales(queryClient);
    toast({
      title: t('sales.noteForm.done', {
        kind: label('taxDocumentKinds', issued.kind),
        number: String(issued.number),
      }),
      tone: 'success',
    });
    void navigate(`/notes/${issued.id}`);
    return undefined;
  };

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          setKind(first);
          setReason('discount');
          setScheme('');
          setIncludesTax(invoice.priceMode === 'inclusive');
          setValues({});
          setNote('');
          setErrors({});
          setOpen(true);
        }}
      >
        {t('sales.adjust.note')}
      </Button>
      <FormDialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title={t('sales.noteForm.title', { number: String(invoice.number) })}
        description={t('sales.noteForm.description')}
        submitLabel={t('sales.noteForm.submit')}
        onSubmit={submit}
      >
        <div className="filters">
          <Field label={t('sales.noteForm.kind')}>
            <Select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as NoteKind);
              }}
            >
              {kinds.map((value) => (
                <option key={value} value={value}>
                  {label('taxDocumentKinds', value)}
                </option>
              ))}
            </Select>
          </Field>
          {credit && (
            <Field label={t('sales.noteForm.reason')}>
              <Select
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value as ValueCreditNoteReason);
                }}
              >
                {VALUE_CREDIT_NOTE_REASONS.map((value) => (
                  <option key={value} value={value}>
                    {label('noteReasons', value)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {credit && reason === 'discount' && (
          <Field
            label={t('sales.noteForm.scheme')}
            hint={t('sales.noteForm.schemeHint')}
            {...(errors.scheme === undefined ? {} : { error: errors.scheme })}
          >
            <Input
              value={scheme}
              onChange={(event) => {
                setScheme(event.target.value);
              }}
            />
          </Field>
        )}
        <Checkbox
          label={t('sales.noteForm.includesTax')}
          checked={includesTax}
          onChange={(event) => {
            setIncludesTax(event.target.checked);
          }}
        />
        <div className="stack">
          {invoice.lines.map((line) => {
            const item = String(line.description);
            return (
              <Field
                key={line.id}
                label={t('sales.noteForm.value', { item })}
                hint={t('sales.noteForm.valueHint', { amount: money(line.totalPaise) })}
                {...(errors[line.id] === undefined ? {} : { error: errors[line.id] })}
              >
                <Input
                  inputMode="decimal"
                  value={values[line.id] ?? ''}
                  onChange={(event) => {
                    setValues((current) => ({ ...current, [line.id]: event.target.value }));
                  }}
                />
              </Field>
            );
          })}
        </div>
        <Field label={t('sales.noteForm.note')}>
          <Textarea
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </Field>
        <Card title={t('sales.preview.noteTitle')}>
          {preview === null ? (
            <Alert tone="info">{t('sales.preview.empty')}</Alert>
          ) : (
            <>
              <p className="cell-meta">{t('sales.preview.hint')}</p>
              <TaxTotals totals={{ ...preview, totalPaise: preview.payablePaise }} />
            </>
          )}
        </Card>
      </FormDialog>
    </>
  );
}
