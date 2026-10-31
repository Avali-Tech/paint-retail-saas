import { Badge, Button, Card, Icon, buttonStyle } from '@paint/ui';
import type { SetupChecklistView } from '@paint/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { GETTING_STARTED_PATH, STEP_PATHS, dismiss, isDismissed } from './checklist.js';

export const CHECKLIST_KEY = ['onboarding'] as const;

/** The business's checklist, worked out from its records (GET /onboarding). */
export function useChecklist(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: CHECKLIST_KEY,
    queryFn: ({ signal }) => api.setup.checklist(signal),
    enabled,
  });
}

/** "4 of 9 done" with a bar. */
export function ChecklistProgress({ checklist }: { readonly checklist: SetupChecklistView }) {
  const { t } = useI18n();
  const text = t('gettingStarted.progress', {
    done: String(checklist.completed),
    total: String(checklist.total),
  });
  return (
    <div className="stack">
      <progress value={checklist.completed} max={checklist.total} aria-label={text} />
      <p className="cell-meta">{text}</p>
    </div>
  );
}

/** Each step, done or not, with a link to the screen that does it. */
export function ChecklistSteps({ checklist }: { readonly checklist: SetupChecklistView }) {
  const { t } = useI18n();
  return (
    <ol className="record-list" aria-label={t('gettingStarted.steps')}>
      {checklist.steps.map((step) => {
        const title = t(`gettingStarted.step.${step.key}.title`);
        return (
          <li key={step.key} className="record-list__row">
            <span className="picker__who">
              <span className="record-list__title">
                {step.done && <Icon name="check" size={16} />} {title}
              </span>
              <span className="record-list__meta">{t(`gettingStarted.step.${step.key}.hint`)}</span>
            </span>
            <span className="row">
              <Badge tone={step.done ? 'success' : 'warning'}>
                {t(step.done ? 'gettingStarted.done' : 'gettingStarted.todo')}
              </Badge>
              <Link
                to={STEP_PATHS[step.key]}
                aria-label={t('gettingStarted.openStep', { step: title })}
                {...buttonStyle('secondary', 'sm')}
              >
                {t('gettingStarted.open')}
              </Link>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The checklist on Home, for owners and admins, until every step is done or it is hidden
 * on this device. Nothing shows while it loads, or if it cannot be read: Home stays usable.
 */
export function GettingStartedCard() {
  const { t } = useI18n();
  const can = usePermissions();
  const profile = useCurrentProfile();
  const organizationId = profile.organization.id;
  const [hidden, setHidden] = useState(() => isDismissed(localStorage, organizationId));
  const owner = can('organization:manage');
  const checklist = useChecklist(owner && !hidden);
  const data = checklist.data;
  if (!owner || hidden || data === undefined || data.completed === data.total) return null;
  return (
    <Card
      title={t('gettingStarted.title')}
      actions={
        <span className="row">
          <Link to={GETTING_STARTED_PATH} {...buttonStyle('secondary', 'sm')}>
            {t('gettingStarted.seeAll')}
          </Link>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              dismiss(localStorage, organizationId);
              setHidden(true);
            }}
          >
            {t('gettingStarted.hide')}
          </Button>
        </span>
      }
    >
      <div className="stack">
        <ChecklistProgress checklist={data} />
        <ChecklistSteps checklist={data} />
      </div>
    </Card>
  );
}
