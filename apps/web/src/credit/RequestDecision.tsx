import { Button, Field, Textarea, useToast } from '@paint/ui';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';

/** After any credit change: the customer 360s, the request lists and the inbox load again. */
export async function refreshCredit(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['party'] }),
    queryClient.invalidateQueries({ queryKey: ['credit-requests'] }),
    queryClient.invalidateQueries({ queryKey: ['inbox'] }),
  ]);
}

/** Approve and Reject buttons for a pending credit request (credit:approve), each with its dialog. */
export function RequestDecision({
  request,
}: {
  readonly request: { readonly id: string; readonly number: string };
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null);
  const [text, setText] = useState('');
  const rejecting = mode === 'reject';

  const open = (next: 'approve' | 'reject') => {
    setText('');
    setMode(next);
  };

  return (
    <>
      <Button
        size="sm"
        aria-label={t('credit.approveNumber', { number: request.number })}
        onClick={() => {
          open('approve');
        }}
      >
        {t('credit.approve')}
      </Button>
      <Button
        size="sm"
        variant="danger"
        aria-label={t('credit.rejectNumber', { number: request.number })}
        onClick={() => {
          open('reject');
        }}
      >
        {t('credit.reject')}
      </Button>
      <FormDialog
        open={mode !== null}
        onClose={() => {
          setMode(null);
        }}
        title={t(rejecting ? 'credit.rejectTitle' : 'credit.approveTitle', {
          number: request.number,
        })}
        submitLabel={t(rejecting ? 'credit.reject' : 'credit.approve')}
        onSubmit={async () => {
          const note = text.trim();
          if (rejecting) {
            if (note.length < 3) return t('credit.reasonInvalid');
            await api.credit.reject(request.id, note);
          } else {
            await api.credit.approve(request.id, note === '' ? undefined : note);
          }
          await refreshCredit(queryClient);
          toast({ title: t(rejecting ? 'credit.rejected' : 'credit.approved'), tone: 'success' });
          return undefined;
        }}
      >
        <Field label={t(rejecting ? 'credit.reason' : 'credit.approveNote')}>
          <Textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        </Field>
      </FormDialog>
    </>
  );
}
