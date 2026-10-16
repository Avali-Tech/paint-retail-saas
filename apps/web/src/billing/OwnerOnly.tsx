import { Alert, PageHeader } from '@paint/ui';
import type { ReactNode } from 'react';
import { useCurrentProfile } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';

/** The page for the business's owner; anyone else is told who manages billing. */
export function OwnerOnly({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  const profile = useCurrentProfile();
  if (profile.role.key === 'owner') return children;
  return (
    <>
      <PageHeader title={t('subscription.title')} />
      <Alert tone="info" title={t('subscription.ownerOnlyTitle')}>
        {t('subscription.ownerOnly')}
      </Alert>
    </>
  );
}
