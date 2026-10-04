import { Field, Textarea } from '@paint/ui';
import { useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from './FormDialog.js';

export interface ReasonDialogProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly submitLabel: string;
  /** Saves with the reason; throw (an API error) to show its message. */
  readonly onSubmit: (reason: string) => Promise<unknown>;
  readonly onClose: () => void;
}

/** Asks why before rejecting, cancelling or closing something (the API wants 3+ characters). */
export function ReasonDialog({
  title,
  description,
  submitLabel,
  onSubmit,
  onClose,
}: ReasonDialogProps) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={title}
      {...(description === undefined ? {} : { description })}
      submitLabel={submitLabel}
      onSubmit={async () => {
        if (reason.trim().length < 3) return t('workflow.reasonInvalid');
        await onSubmit(reason.trim());
        return undefined;
      }}
    >
      <Field label={t('workflow.reason')} required>
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
