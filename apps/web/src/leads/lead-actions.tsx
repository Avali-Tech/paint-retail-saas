import { Field, Input, useToast } from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { OPEN_LEAD_STAGES, type Lead, type OpenLeadStage } from '../api/leads.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { stageLabel, useI18n, type MessageKey } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { parseRupees, rupeesInput } from '../lib/inputs.js';
import { wholeNumber } from '../lib/numbers.js';
import { ReasonDialog } from '../lib/ReasonDialog.js';
import type { MenuAction } from './ActionMenu.js';
import { given, refreshCrm } from './crm.js';

/** What can happen to a lead next, by the API's stage rules. */
export type LeadStep =
  | { readonly kind: 'move'; readonly stage: OpenLeadStage }
  | { readonly kind: 'convert' | 'win' | 'lose' | 'reopen' };

export function leadSteps(lead: Pick<Lead, 'stage' | 'opportunityId'>): LeadStep[] {
  const { stage } = lead;
  if (stage === 'lost') return lead.opportunityId === null ? [{ kind: 'reopen' }] : [];
  if (stage !== 'new' && stage !== 'contacted' && stage !== 'qualified') return [];
  return [
    ...OPEN_LEAD_STAGES.filter((next) => next !== stage).map((next): LeadStep => ({
      kind: 'move',
      stage: next,
    })),
    ...(stage === 'qualified' ? [{ kind: 'convert' } as const, { kind: 'win' } as const] : []),
    { kind: 'lose' },
  ];
}

function ConvertDialog({ lead, onClose }: { readonly lead: Lead; readonly onClose: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(lead.title);
  const [value, setValue] = useState(rupeesInput(lead.estimatedValuePaise));
  const [date, setDate] = useState(lead.expectedOrderDate ?? '');
  const [probability, setProbability] = useState('20');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('leads.convert.title', { number: lead.number })}
      description={t('leads.convert.description')}
      submitLabel={t('leads.convert.submit')}
      onSubmit={async () => {
        const paise = parseRupees(value);
        if (paise === null || paise < 0) return t('leads.convert.valueInvalid');
        const chance = wholeNumber(0, 100, '').safeParse(probability);
        if (!chance.success) return t('leads.convert.probabilityInvalid');
        if (title.trim().length < 3) return t('leads.form.titleInvalid');
        const opportunity = await api.leads.convert(lead.id, {
          title: title.trim(),
          expectedValuePaise: paise,
          probability: chance.data,
          ...(given(date) === undefined ? {} : { expectedOrderDate: date }),
        });
        await refreshCrm(queryClient);
        toast({ title: t('leads.convert.done', { number: opportunity.number }), tone: 'success' });
        void navigate(`/opportunities/${opportunity.id}`);
        return undefined;
      }}
    >
      <Field label={t('leads.form.title')} required>
        <Input
          maxLength={160}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
      </Field>
      <div className="form-grid">
        <Field label={t('leads.convert.value')} required>
          <Input
            inputMode="decimal"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </Field>
        <Field label={t('leads.convert.probability')}>
          <Input
            inputMode="numeric"
            value={probability}
            onChange={(event) => {
              setProbability(event.target.value);
            }}
          />
        </Field>
        <Field label={t('leads.form.expectedOrderDate')}>
          <Input
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
            }}
          />
        </Field>
      </div>
    </FormDialog>
  );
}

/**
 * A lead's next steps as menu actions, and the dialogs some of them open
 * (a reason to lose it, the opportunity's value to convert it). Empty for
 * members who cannot change leads.
 */
export function useLeadActions(lead: Lead): {
  readonly actions: MenuAction[];
  readonly dialogs: ReactNode;
} {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const can = usePermissions();
  const [open, setOpen] = useState<'convert' | 'lose' | null>(null);
  const close = () => {
    setOpen(null);
  };

  const run = (work: () => Promise<Lead>, done: MessageKey, params = {}) => {
    void (async () => {
      try {
        await work();
        toast({ title: t(done, params), tone: 'success' });
      } catch (error) {
        toast({
          title: t('leads.actions.failed'),
          description: errorMessage(error),
          tone: 'danger',
        });
      } finally {
        await refreshCrm(queryClient);
      }
    })();
  };

  const actions = can('leads:manage')
    ? leadSteps(lead).map((step): MenuAction => {
        switch (step.kind) {
          case 'move': {
            const name = stageLabel(t, step.stage);
            return {
              key: `move-${step.stage}`,
              label: t('leads.actions.moveTo', { stage: name }),
              onSelect: () => {
                run(() => api.leads.moveTo(lead.id, step.stage), 'leads.actions.moved', {
                  number: lead.number,
                  stage: name,
                });
              },
            };
          }
          case 'convert':
          case 'lose': {
            const kind = step.kind;
            return {
              key: kind,
              label: t(kind === 'convert' ? 'leads.actions.convert' : 'leads.actions.lose'),
              onSelect: () => {
                setOpen(kind);
              },
            };
          }
          case 'win':
            return {
              key: 'win',
              label: t('leads.actions.win'),
              onSelect: () => {
                run(() => api.leads.win(lead.id), 'leads.actions.won', { number: lead.number });
              },
            };
          case 'reopen':
            return {
              key: 'reopen',
              label: t('leads.actions.reopen'),
              onSelect: () => {
                run(() => api.leads.reopen(lead.id), 'leads.actions.reopened', {
                  number: lead.number,
                });
              },
            };
        }
      })
    : [];

  const dialogs = (
    <>
      {open === 'convert' && <ConvertDialog lead={lead} onClose={close} />}
      {open === 'lose' && (
        <ReasonDialog
          title={t('leads.actions.loseTitle', { number: lead.number })}
          submitLabel={t('leads.actions.lose')}
          onClose={close}
          onSubmit={async (reason) => {
            await api.leads.lose(lead.id, reason);
            await refreshCrm(queryClient);
            toast({ title: t('leads.actions.lost', { number: lead.number }), tone: 'success' });
          }}
        />
      )}
    </>
  );
  return { actions, dialogs };
}
