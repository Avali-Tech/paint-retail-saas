import { Field, Textarea, useToast } from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { refreshCollections } from './PromiseDialog.js';

/** Marks the escalation of a broken promise as seen and acted on, with an optional note. */
export function AcknowledgeDialog({
  escalationId,
  onClose,
}: {
  readonly escalationId: string;
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
      title={t('collections.acknowledgeTitle')}
      description={t('collections.acknowledgeDescription')}
      submitLabel={t('collections.acknowledge')}
      onSubmit={async () => {
        await api.collections.acknowledge(
          escalationId,
          note.trim() === '' ? undefined : note.trim(),
        );
        await refreshCollections(queryClient);
        toast({ title: t('collections.acknowledged'), tone: 'success' });
        return undefined;
      }}
    >
      <Field label={t('collections.acknowledgeNote')}>
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
