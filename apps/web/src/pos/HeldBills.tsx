import { Alert, Button, Dialog } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { forgetDraft, readSnapshot } from './held.js';

export const draftsKey = (storeId: string) => ['pos-drafts', storeId] as const;

/**
 * The held-bills tray (spec §5.2: F4 holds, the tray resumes any draft): every
 * draft at the store except the one on the counter, newest first.
 */
export function HeldBills({
  storeId,
  currentDraftId,
  onResume,
}: {
  readonly storeId: string;
  readonly currentDraftId: string | null;
  readonly onResume: (draftId: string) => void;
}) {
  const api = useApi();
  const { t, money } = useI18n();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const drafts = useQuery({
    queryKey: draftsKey(storeId),
    queryFn: ({ signal }) => api.pos.drafts(storeId, signal),
  });
  const held = (drafts.data?.items ?? []).filter((draft) => draft.id !== currentDraftId);

  const discard = async (draftId: string) => {
    setMessage(null);
    try {
      await api.pos.discardDraft(draftId);
      forgetDraft(localStorage, draftId);
      await queryClient.invalidateQueries({ queryKey: draftsKey(storeId) });
      setMessage(t('pos.held.discarded'));
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setMessage(null);
          setOpen(true);
        }}
      >
        {t('pos.held.button', { count: held.length })}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('pos.held.title')}
        closeLabel={t('common.close')}
      >
        <div className="stack">
          {message !== null && <Alert tone="info">{message}</Alert>}
          {held.length === 0 ? (
            <p className="muted">{t('pos.held.empty')}</p>
          ) : (
            <ul className="record-list">
              {held.map((draft) => {
                const snapshot = readSnapshot(localStorage, draft.id);
                const name = snapshot?.buyer.partyName ?? draft.buyerName ?? t('pos.held.walkIn');
                return (
                  <li key={draft.id} className="record-list__row">
                    <span>
                      <span className="record-list__title">{name}</span>{' '}
                      <span className="record-list__meta">
                        {snapshot === null
                          ? t('pos.held.unknownTotal')
                          : money(snapshot.payablePaise)}
                      </span>
                    </span>
                    <span className="row">
                      <Button
                        size="sm"
                        aria-label={t('pos.held.resumeLabel', { name })}
                        onClick={() => {
                          setOpen(false);
                          onResume(draft.id);
                        }}
                      >
                        {t('pos.held.resume')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('pos.held.discardLabel', { name })}
                        onClick={() => {
                          void discard(draft.id);
                        }}
                      >
                        {t('pos.held.discard')}
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Dialog>
    </>
  );
}
