import { Button, Dialog } from '@paint/ui';
import { useId } from 'react';
import type { BusinessChoice } from '../api/errors.js';
import { useI18n } from '../i18n/i18n.js';
import { usePreferredBusiness } from './sign-in-business.js';

export interface ChooseBusinessProps {
  readonly businesses: readonly BusinessChoice[];
  readonly onChoose: (business: BusinessChoice) => void;
  readonly onCancel: () => void;
}

/**
 * Shown when a person works with several businesses: pick which one to open. On a
 * branded sign-in page, that page's business comes first; the others stay offered,
 * since the person belongs to them (the list comes from the server after the password).
 */
export function ChooseBusiness({ businesses, onChoose, onCancel }: ChooseBusinessProps) {
  const { t } = useI18n();
  const preferred = usePreferredBusiness();
  const hintId = useId();
  const isPreferred = (business: BusinessChoice) =>
    preferred !== null && business.slug === preferred;
  const ordered = [...businesses].sort((a, b) => Number(isPreferred(b)) - Number(isPreferred(a)));
  return (
    <Dialog
      open={businesses.length > 0}
      // Without a trigger the dialog only ever asks to close (Escape, outside click, ×).
      onOpenChange={onCancel}
      title={t('auth.chooseBusiness')}
      description={t('auth.chooseBusinessHint')}
      closeLabel={t('common.close')}
    >
      <ul className="business-list">
        {ordered.map((business) => (
          <li key={business.id}>
            <Button
              variant={isPreferred(business) ? 'primary' : 'secondary'}
              className="business-list__item"
              aria-describedby={isPreferred(business) ? hintId : undefined}
              onClick={() => {
                onChoose(business);
              }}
            >
              {business.name}
            </Button>
            {isPreferred(business) && (
              <p id={hintId} className="muted">
                {t('branding.preferredBusiness')}
              </p>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
