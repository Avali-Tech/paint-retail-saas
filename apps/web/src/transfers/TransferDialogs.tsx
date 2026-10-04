import { Field, Input, Textarea } from '@paint/ui';
import { useState, type ReactNode } from 'react';
import type { QuantityLine, ReceiveLine, Transfer, TransferLine } from '../api/transfers.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { parseNonNegative } from './quantity.js';

export interface QuantitiesDialogProps {
  readonly transfer: Transfer;
  readonly title: string;
  readonly description: ReactNode;
  readonly submitLabel: string;
  /** e.g. "Quantity of {sku} to approve". */
  readonly fieldLabel: MessageKey;
  /** The most each line may take, and its starting value. */
  readonly max: (line: TransferLine) => number;
  readonly onSubmit: (lines: QuantityLine[]) => Promise<unknown>;
  readonly onClose: () => void;
}

/** Approve or dispatch: one quantity per line, at most `max(line)`. */
export function QuantitiesDialog({
  transfer,
  title,
  description,
  submitLabel,
  fieldLabel,
  max,
  onSubmit,
  onClose,
}: QuantitiesDialogProps) {
  const { t, number } = useI18n();
  const [rows, setRows] = useState(() =>
    transfer.lines.map((line) => ({ line, value: String(max(line)) })),
  );
  const [problems, setProblems] = useState<Record<string, string>>({});
  return (
    <FormDialog
      open
      onClose={onClose}
      title={title}
      description={description}
      submitLabel={submitLabel}
      onSubmit={async () => {
        const found: Record<string, string> = {};
        const lines = rows.map(({ line, value }) => {
          const quantity = parseNonNegative(value);
          if (quantity === null) found[line.variantId] = t('transfers.quantityInvalid');
          else if (quantity > max(line)) {
            found[line.variantId] = t('transfers.detail.max', { max: number(max(line)) });
          }
          return { variantId: line.variantId, quantity: Number(quantity) };
        });
        setProblems(found);
        if (Object.keys(found).length > 0) return false;
        // The API needs at least one line to move; reject the transfer instead.
        if (lines.every((line) => line.quantity === 0)) return t('transfers.detail.nothing');
        await onSubmit(lines);
        return undefined;
      }}
    >
      {rows.map(({ line, value }) => (
        <Field
          key={line.variantId}
          label={t(fieldLabel, { sku: line.sku })}
          hint={`${line.brandName} ${line.productName} · ${t('transfers.detail.max', { max: number(max(line)) })}`}
          error={problems[line.variantId]}
        >
          <Input
            inputMode="decimal"
            value={value}
            onChange={(event) => {
              const typed = event.target.value;
              setRows((current) =>
                current.map((row) =>
                  row.line.variantId === line.variantId ? { ...row, value: typed } : row,
                ),
              );
            }}
          />
        </Field>
      ))}
    </FormDialog>
  );
}

export interface ReceiveDialogProps {
  readonly transfer: Transfer;
  readonly onSubmit: (input: { note?: string; lines: ReceiveLine[] }) => Promise<unknown>;
  readonly onClose: () => void;
}

interface Arrival {
  readonly line: TransferLine;
  readonly received: string;
  readonly damaged: string;
}

/** What arrived of each dispatched line: good and damaged units (the rest is short). */
export function ReceiveDialog({ transfer, onSubmit, onClose }: ReceiveDialogProps) {
  const { t, number } = useI18n();
  const [rows, setRows] = useState<Arrival[]>(() =>
    transfer.lines.map((line) => ({
      line,
      received: String(Number(line.dispatchedQuantity)),
      damaged: '0',
    })),
  );
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const change = (variantId: string, field: 'received' | 'damaged', value: string) => {
    setRows((current) =>
      current.map((row) => (row.line.variantId === variantId ? { ...row, [field]: value } : row)),
    );
  };
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('transfers.detail.receiveTitle', { number: transfer.number })}
      description={t('transfers.detail.receiveDescription')}
      submitLabel={t('transfers.detail.receive')}
      onSubmit={async () => {
        const found: Record<string, string> = {};
        const lines = rows.map((entry) => {
          const { line } = entry;
          const received = parseNonNegative(entry.received);
          const damaged = parseNonNegative(entry.damaged);
          const dispatched = Number(line.dispatchedQuantity);
          if (received === null)
            found[`received-${line.variantId}`] = t('transfers.quantityInvalid');
          if (damaged === null) found[`damaged-${line.variantId}`] = t('transfers.quantityInvalid');
          else if (received !== null && received + damaged > dispatched) {
            found[`damaged-${line.variantId}`] = t('transfers.detail.tooMany', {
              dispatched: number(dispatched),
            });
          }
          return {
            variantId: line.variantId,
            received: Number(received),
            damaged: Number(damaged),
          };
        });
        setProblems(found);
        if (Object.keys(found).length > 0) return false;
        await onSubmit({ ...(note.trim() === '' ? {} : { note: note.trim() }), lines });
        return undefined;
      }}
    >
      {rows.map((entry) => {
        const { line } = entry;
        return (
          <fieldset key={line.variantId} className="variant-row">
            <legend>
              {line.sku} · {line.brandName} {line.productName} · {t('transfers.detail.dispatched')}{' '}
              {number(Number(line.dispatchedQuantity))}
            </legend>
            <div className="form-grid">
              <Field
                label={t('transfers.detail.receivedQuantity', { sku: line.sku })}
                error={problems[`received-${line.variantId}`]}
              >
                <Input
                  inputMode="decimal"
                  value={entry.received}
                  onChange={(event) => {
                    change(line.variantId, 'received', event.target.value);
                  }}
                />
              </Field>
              <Field
                label={t('transfers.detail.damagedQuantity', { sku: line.sku })}
                error={problems[`damaged-${line.variantId}`]}
              >
                <Input
                  inputMode="decimal"
                  value={entry.damaged}
                  onChange={(event) => {
                    change(line.variantId, 'damaged', event.target.value);
                  }}
                />
              </Field>
            </div>
          </fieldset>
        );
      })}
      <Field label={t('transfers.detail.receiveNote')}>
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
