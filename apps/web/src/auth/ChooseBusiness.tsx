import { Button, Dialog } from '@paint/ui';
import type { BusinessChoice } from '../api/errors.js';
import { useI18n } from '../i18n/i18n.js';

export interface ChooseBusinessProps {
  readonly businesses: readonly BusinessChoice[];
  readonly onChoose: (business: BusinessChoice) => void;
  readonly onCancel: () => void;
}

/** Shown when a person works with several businesses: pick which one to open. */
export function ChooseBusiness({ businesses, onChoose, onCancel }: ChooseBusinessProps) {
  const { t } = useI18n();
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
        {businesses.map((business) => (
          <li key={business.id}>
            <Button
              variant="secondary"
              className="business-list__item"
              onClick={() => {
                onChoose(business);
              }}
            >
              {business.name}
            </Button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
