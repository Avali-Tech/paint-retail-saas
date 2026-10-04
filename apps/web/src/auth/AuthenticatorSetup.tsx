import { Field, Input } from '@paint/ui';
import type { TwoFactorEnrolment } from '../api/types.js';
import { useI18n } from '../i18n/i18n.js';
import { QrCode } from './QrCode.js';

/** "ABCDEFGHIJ" → "ABCD EFGH IJ": easier to type into an app by hand. */
export function groupKey(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

/** Adding an authenticator app: the QR code to scan, a link for this phone, and the key to type. */
export function AuthenticatorSetup({ enrolment }: { readonly enrolment: TwoFactorEnrolment }) {
  const { t } = useI18n();
  return (
    <div className="authenticator-setup">
      <p>{t('twoFactor.scan')}</p>
      <QrCode value={enrolment.otpauthUri} label={t('twoFactor.qrLabel')} />
      <a className="authenticator-setup__link" href={enrolment.otpauthUri}>
        {t('twoFactor.openApp')}
      </a>
      <Field label={t('twoFactor.setupKey')} hint={t('twoFactor.setupKeyHint')}>
        <Input
          readOnly
          className="authenticator-setup__key"
          value={groupKey(enrolment.secret)}
          spellCheck={false}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
        />
      </Field>
    </div>
  );
}
