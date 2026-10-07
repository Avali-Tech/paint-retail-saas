import { Button, Icon } from '@paint/ui';
import { useState, useSyncExternalStore } from 'react';
import { useI18n } from '../i18n/i18n.js';
import type { UpdateController } from './updates.js';

/**
 * "A new version is available – Reload". It never takes focus or reloads on its own, so
 * nobody loses a half-filled form; "Later" hides it until the next page load.
 */
export function UpdateBanner({ updates }: { readonly updates: UpdateController }) {
  const { t } = useI18n();
  const available = useSyncExternalStore(updates.subscribe, updates.isAvailable);
  const [later, setLater] = useState(false);
  const [reloading, setReloading] = useState(false);
  return (
    // The live region is always there, so screen readers announce the banner when it appears.
    <section className="update-banner-region" aria-label={t('update.region')} aria-live="polite">
      {available && !later && (
        <div className="update-banner">
          <span className="update-banner__text">{t('update.available')}</span>
          <Button
            size="sm"
            loading={reloading}
            onClick={() => {
              setReloading(true);
              updates.apply();
            }}
          >
            {t('update.reload')}
          </Button>
          <button
            type="button"
            className="ui-icon-button"
            aria-label={t('update.later')}
            onClick={() => {
              setLater(true);
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
    </section>
  );
}
