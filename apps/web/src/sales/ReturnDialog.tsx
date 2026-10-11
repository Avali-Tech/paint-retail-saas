import { Alert, Button, Card, Field, Input, Textarea, useToast } from '@paint/ui';
import {
  computeReturn,
  noteSourceOf,
  type InvoiceAdjustments,
  type ReturnDisposition,
  type TaxDocumentView,
} from '@paint/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { SalesReturnInput } from '../api/sales.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { parsePositiveQuantity } from '../lib/quantity.js';
import { refreshSales } from './refresh.js';
import { TaxTotals } from './TaxTotals.js';

type Typed = Record<string, Record<ReturnDisposition, string>>;
const EMPTY = { restock: '', damage: '' };

/** Thousandths, so typed quantities add up exactly. */
const milli = (quantity: number) => Math.round(quantity * 1000);

interface ReturnLine {
  readonly id: string;
  readonly lineNo: number;
  readonly item: string;
  readonly sold: number;
  readonly returned: number;
  readonly left: number;
}

/** One typed quantity: 0 when left empty, null when it is not a quantity. */
const quantityOf = (text: string): number | null =>
  text.trim() === '' ? 0 : parsePositiveQuantity(text);

/**
 * "Return items" on an invoice: per line, how many go back to stock and how many
 * are damaged, with the credit note's tax previewed by the GST engine as the
 * server will compute it (at the invoice's rate, pro rata by quantity).
 */
export function ReturnDialog({
  invoice,
  adjustments,
}: {
  readonly invoice: TaxDocumentView;
  readonly adjustments: InvoiceAdjustments;
}) {
  const api = useApi();
  const { t, number } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState<Typed>({});
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const lines: ReturnLine[] = adjustments.lines
    .map((done) => {
      const line = invoice.lines.find((candidate) => candidate.id === done.invoiceLineId);
      return {
        id: done.invoiceLineId,
        lineNo: done.lineNo,
        item: String(line?.description),
        sold: done.soldQuantity,
        returned: done.returnedQuantity,
        left: (milli(done.soldQuantity) - milli(done.returnedQuantity)) / 1000,
      };
    })
    .filter((line) => line.left > 0);

  /** Per line: the typed quantities, null for a line typed wrongly or more than is left. */
  const chosen = lines.map((line) => {
    const entry = typed[line.id] ?? EMPTY;
    const restock = quantityOf(entry.restock);
    const damage = quantityOf(entry.damage);
    if (restock === null || damage === null)
      return { line, restock: 0, damage: 0, error: 'invalid' };
    if (milli(restock) + milli(damage) > milli(line.left)) {
      return { line, restock, damage, error: 'tooMany' };
    }
    return { line, restock, damage, error: null };
  });
  const valid = chosen.filter((entry) => entry.error === null && entry.restock + entry.damage > 0);
  const preview =
    valid.length === 0
      ? null
      : computeReturn(
          noteSourceOf(invoice),
          valid.map(({ line, restock, damage }) => ({
            lineIndex: line.lineNo,
            quantity: (milli(restock) + milli(damage)) / 1000,
            previouslyReturnedQuantity: line.returned,
          })),
          true,
        ).totals;

  const type = (lineId: string, disposition: ReturnDisposition, value: string) => {
    setTyped((current) => ({
      ...current,
      [lineId]: { ...(current[lineId] ?? EMPTY), [disposition]: value },
    }));
  };

  const submit = async () => {
    const problems: Record<string, string> = {};
    for (const entry of chosen) {
      if (entry.error === 'invalid') problems[entry.line.id] = t('sales.return.invalid');
      if (entry.error === 'tooMany') {
        problems[entry.line.id] = t('sales.return.tooMany', { count: number(entry.line.left) });
      }
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return false;
    if (valid.length === 0) return t('sales.return.nothing');
    const input: SalesReturnInput = {
      invoiceId: invoice.id,
      lines: valid.flatMap(({ line, restock, damage }) => [
        ...(restock > 0
          ? [{ invoiceLineId: line.id, quantity: restock, disposition: 'restock' as const }]
          : []),
        ...(damage > 0
          ? [{ invoiceLineId: line.id, quantity: damage, disposition: 'damage' as const }]
          : []),
      ]),
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    };
    const done = await api.sales.returnGoods(input);
    await refreshSales(queryClient);
    toast({
      title: t('sales.return.done', { number: String(done.creditNote.number) }),
      tone: 'success',
    });
    void navigate(`/notes/${done.creditNote.id}`);
    return undefined;
  };

  return (
    <>
      <Button
        onClick={() => {
          setTyped({});
          setNote('');
          setErrors({});
          setOpen(true);
        }}
      >
        {t('sales.adjust.returnItems')}
      </Button>
      <FormDialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title={t('sales.return.title', { number: String(invoice.number) })}
        description={t('sales.return.description')}
        submitLabel={t('sales.return.submit')}
        onSubmit={submit}
      >
        <ul className="doc-lines">
          {lines.map((line) => (
            <li key={line.id} className="doc-line">
              <div className="doc-line__head">
                <span className="doc-line__title">{line.item}</span>
              </div>
              <div className="doc-line__fields">
                {(['restock', 'damage'] as const).map((disposition) => (
                  <Field
                    key={disposition}
                    label={`${t(`sales.return.${disposition}`)} · ${line.item}`}
                    hint={t('sales.return.left', {
                      count: number(line.left),
                      sold: number(line.sold),
                    })}
                    {...(errors[line.id] === undefined ? {} : { error: errors[line.id] })}
                  >
                    <Input
                      inputMode="decimal"
                      value={(typed[line.id] ?? EMPTY)[disposition]}
                      onChange={(event) => {
                        type(line.id, disposition, event.target.value);
                      }}
                    />
                  </Field>
                ))}
              </div>
            </li>
          ))}
        </ul>
        <Field label={t('sales.return.note')}>
          <Textarea
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </Field>
        <Card title={t('sales.preview.title')}>
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
