import { Alert, Card, PageHeader } from '@paint/ui';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { ChecklistProgress, ChecklistSteps, useChecklist } from './GettingStarted.js';

/**
 * /settings/getting-started — a new business's first steps, each ticked off from its
 * real data and linked to the screen that does it.
 */
export function GettingStartedPage() {
  const { t } = useI18n();
  const checklist = useChecklist();
  return (
    <>
      <PageHeader title={t('gettingStarted.title')} description={t('gettingStarted.description')} />
      <QueryState query={checklist} error="gettingStarted.error">
        {(data) => (
          <Card>
            <div className="stack">
              <ChecklistProgress checklist={data} />
              {data.completed === data.total && (
                <Alert tone="success">{t('gettingStarted.complete')}</Alert>
              )}
              <ChecklistSteps checklist={data} />
            </div>
          </Card>
        )}
      </QueryState>
    </>
  );
}
