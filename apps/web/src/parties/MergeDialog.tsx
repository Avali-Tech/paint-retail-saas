import { Button, useToast } from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { Party } from '../api/parties.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { PartyPicker } from './PartyPicker.js';

const RULES = ['moves', 'roles', 'credit', 'loyalty', 'final'] as const;

/**
 * Merges a duplicate into the record that stays: choose it, read what happens
 * (the API has no preview; its credit and loyalty refusals are shown as they
 * come), merge, then open the record that stays.
 */
export function MergeDialog({
  party,
  onClose,
}: {
  readonly party: Party;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, plural } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [survivor, setSurvivor] = useState<Party | null>(null);
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('parties.merge.title', { name: party.displayName })}
      description={t('parties.merge.description', { name: party.displayName })}
      submitLabel={t('parties.merge.submit')}
      onSubmit={async () => {
        if (survivor === null) return t('parties.merge.chooseFirst');
        if (survivor.id === party.id) return t('parties.merge.same');
        const result = await api.parties.merge(party.id, survivor.id);
        const moved = Object.values(result.moved).reduce((sum, count) => sum + count, 0);
        await queryClient.invalidateQueries({
          predicate: (query) => ['parties', 'party'].includes(String(query.queryKey[0])),
        });
        toast({
          title: t('parties.merge.merged', { name: result.party.displayName }),
          description: plural('parties.merge.moved', moved),
          tone: 'success',
        });
        void navigate(`/parties/${result.party.id}`);
        return undefined;
      }}
    >
      {survivor === null ? (
        <PartyPicker title={t('parties.merge.pick')} onPick={setSurvivor} />
      ) : (
        <div className="row">
          <strong>
            {t('parties.merge.keep', {
              name: survivor.displayName,
              duplicate: party.displayName,
            })}
          </strong>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSurvivor(null);
            }}
          >
            {t('parties.merge.chooseOther')}
          </Button>
        </div>
      )}
      <section aria-label={t('parties.merge.rulesTitle')}>
        <h3>{t('parties.merge.rulesTitle')}</h3>
        <ul>
          {RULES.map((rule) => (
            <li key={rule}>{t(`parties.merge.rules.${rule}`)}</li>
          ))}
        </ul>
      </section>
    </FormDialog>
  );
}
