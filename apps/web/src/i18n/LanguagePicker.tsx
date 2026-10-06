import { useId } from 'react';
import { LOCALE_CODES, LOCALES, useI18n, type Locale } from './i18n.js';

/**
 * English · हिन्दी · తెలుగు, each in its own script so anyone finds theirs whatever
 * language the screen is in. The choice applies at once and is kept on this device.
 */
export function LanguagePicker({ onChange }: { readonly onChange?: (locale: Locale) => void }) {
  const { t, locale, setLocale } = useI18n();
  const labelId = useId();
  return (
    <div className="language-picker">
      <span id={labelId} className="language-picker__label">
        {t('language.label')}
      </span>
      <div className="language-picker__options" role="group" aria-labelledby={labelId}>
        {LOCALE_CODES.map((code) => (
          <button
            key={code}
            type="button"
            className="language-picker__option"
            lang={LOCALES[code].lang}
            aria-pressed={code === locale}
            onClick={() => {
              setLocale(code);
              onChange?.(code);
            }}
          >
            {LOCALES[code].label}
          </button>
        ))}
      </div>
    </div>
  );
}
