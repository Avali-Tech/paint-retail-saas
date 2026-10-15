import { Field, Input, Textarea, useToast } from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { todayInIndia } from '../lib/india-time.js';
import { parseRupees } from '../lib/inputs.js';

/** What the worklist and the customer's collections panel show: refreshed after a change. */
export async function refreshCollections(
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['collections'] }),
    queryClient.invalidateQueries({ queryKey: ['promises'] }),
  ]);
}

/**
 * Records a promise to pay (P2-M11): an amount up to what the customer owes, by a
 * date from today up to 60 days ahead; the server checks both again.
 */
export function PromiseDialog({
  party,
  owedPaise,
  onClose,
}: {
  readonly party: { readonly id: string; readonly name: string };
  /** What the customer owes now, as a hint; null when not known here. */
  readonly owedPaise: number | null;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, money } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayInIndia());
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ amount?: string; date?: string }>({});

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('collections.dialog.title')}
      description={t('collections.dialog.description', { name: party.name })}
      submitLabel={t('collections.dialog.save')}
      onSubmit={async () => {
        const amountPaise = parseRupees(amount);
        const problems = {
          ...(amountPaise === null || amountPaise <= 0
            ? { amount: t('collections.dialog.amountInvalid') }
            : {}),
          ...(date === '' ? { date: t('collections.dialog.dateInvalid') } : {}),
        };
        setErrors(problems);
        if (Object.keys(problems).length > 0) return false;
        await api.collections.createPromise(party.id, {
          amountPaise: Number(amountPaise),
          promisedOn: date,
          ...(note.trim() === '' ? {} : { note: note.trim() }),
        });
        await refreshCollections(queryClient);
        toast({ title: t('collections.dialog.saved'), tone: 'success' });
        return undefined;
      }}
    >
      <Field
        label={t('collections.dialog.amount')}
        required
        error={errors.amount}
        {...(owedPaise === null
          ? {}
          : { hint: t('collections.dialog.amountHint', { amount: money(owedPaise) }) })}
      >
        <Input
          inputMode="decimal"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
          }}
        />
      </Field>
      <Field
        label={t('collections.dialog.date')}
        hint={t('collections.dialog.dateHint')}
        required
        error={errors.date}
      >
        <Input
          type="date"
          value={date}
          onChange={(event) => {
            setDate(event.target.value);
          }}
        />
      </Field>
      <Field label={t('collections.dialog.note')}>
        <Textarea
          maxLength={1000}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}
