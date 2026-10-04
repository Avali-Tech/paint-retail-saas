import { Button, useToast } from '@paint/ui';
import { useId, useState } from 'react';
import { useI18n } from '../i18n/i18n.js';
import { useBranding } from '../theme/BrandingProvider.js';

/** Saves text as a file through the browser's download. */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * New recovery codes, shown once: copy them, download them as a text file,
 * and say they are saved before going on.
 */
export function RecoveryCodes({
  codes,
  onDone,
}: {
  readonly codes: readonly string[];
  readonly onDone: () => void;
}) {
  const { t } = useI18n();
  const { branding } = useBranding();
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const titleId = useId();
  const text = `${[t('recovery.fileHeading', { appName: branding.appName }), '', ...codes].join('\n')}\n`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: t('recovery.copied'), tone: 'success' });
    } catch {
      toast({ title: t('recovery.copyFailed'), tone: 'danger' });
    }
  };

  return (
    <section className="stack" aria-labelledby={titleId}>
      <h2 id={titleId} className="section-title">
        {t('recovery.title')}
      </h2>
      <p>{t('recovery.intro')}</p>
      <ul className="recovery-codes" aria-label={t('recovery.list')}>
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <div className="row">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void copy();
          }}
        >
          {t('recovery.copy')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            downloadText(t('recovery.fileName'), text);
          }}
        >
          {t('recovery.download')}
        </Button>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => {
            setSaved(event.target.checked);
          }}
        />
        <span>{t('recovery.saved')}</span>
      </label>
      <Button disabled={!saved} onClick={onDone}>
        {t('recovery.continue')}
      </Button>
    </section>
  );
}
