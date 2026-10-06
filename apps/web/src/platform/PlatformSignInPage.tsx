import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, Card, Field, Input } from '@paint/ui';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation } from 'react-router';
import { z } from 'zod';
import type { PendingSignIn } from '../api/types.js';
import { showApiError } from '../auth/forms.js';
import { returnPath } from '../auth/SignInPage.js';
import { TwoFactorFlow, splitRecoveryCodes, type TwoFactorCalls } from '../auth/TwoFactorStep.js';
import { LanguagePicker } from '../i18n/LanguagePicker.js';
import { useI18n } from '../i18n/i18n.js';
import type { PlatformSession } from './platform-api.js';
import { useDefaultTheme } from './PlatformLayout.js';
import { usePlatformApi, usePlatformSession, useStartPlatformSession } from './session.js';

interface Values {
  identifier: string;
  password: string;
}

/** Email or mobile number and password: the first of the operator's two steps. */
function PasswordStep({ onPending }: { readonly onPending: (pending: PendingSignIn) => void }) {
  const api = usePlatformApi();
  const { t } = useI18n();
  const schema = useMemo(
    () =>
      z.object({
        identifier: z.string().trim().min(3, t('platform.signIn.required')),
        password: z.string().min(1, t('platform.signIn.required')),
      }),
    [t],
  );
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { identifier: '', password: '' },
  });
  const [message, setMessage] = useState<string | null>(null);
  const { errors, isSubmitting } = form.formState;
  return (
    <form
      className="stack"
      noValidate
      aria-label={t('platform.signIn.title')}
      onSubmit={(event) => {
        void form.handleSubmit(async ({ identifier, password }) => {
          setMessage(null);
          try {
            onPending((await api.login(identifier.trim(), password)).twoFactor);
          } catch (error) {
            setMessage(showApiError(error, ['identifier', 'password'], form.setError));
          }
        })(event);
      }}
    >
      {message !== null && <Alert tone="danger">{message}</Alert>}
      <Field label={t('platform.signIn.identifier')} error={errors.identifier?.message}>
        <Input autoComplete="username" inputMode="email" {...form.register('identifier')} />
      </Field>
      <Field label={t('platform.signIn.password')} error={errors.password?.message}>
        <Input type="password" autoComplete="current-password" {...form.register('password')} />
      </Field>
      <Button type="submit" loading={isSubmitting}>
        {t('platform.signIn.submit')}
      </Button>
    </form>
  );
}

/**
 * /platform/sign-in — operators always use two steps: the password, then an
 * authenticator app (added with a QR code at the first sign-in).
 */
export function PlatformSignInPage() {
  const { t } = useI18n();
  useDefaultTheme();
  const api = usePlatformApi();
  const { session, ended } = usePlatformSession();
  const startSession = useStartPlatformSession();
  const location = useLocation();
  const [pending, setPending] = useState<PendingSignIn | null>(null);
  const calls = useMemo<TwoFactorCalls<PlatformSession>>(
    () => ({
      setUp: api.setUpTwoFactor,
      verify: async (pendingToken, code) =>
        splitRecoveryCodes(await api.verifyTwoFactor(pendingToken, code)),
    }),
    [api],
  );

  if (session !== null) {
    const target = returnPath(location.state);
    return <Navigate to={target.startsWith('/platform') ? target : '/platform'} replace />;
  }

  return (
    <main className="sign-in" id="main">
      <Card className="sign-in__card">
        <div className="sign-in__brand">
          <span className="brand-mark" aria-hidden="true">
            {t('platform.console').slice(0, 1)}
          </span>
          <p className="platform-tag">{t('platform.console')}</p>
          <h1 className="sign-in__title">{t('platform.signIn.title')}</h1>
          <p className="muted">{t('platform.signIn.subtitle')}</p>
        </div>
        {ended === 'expired' && <Alert tone="warning">{t('platform.signIn.expired')}</Alert>}
        {ended === 'signed-out' && <Alert tone="info">{t('platform.signIn.signedOut')}</Alert>}
        {pending === null ? (
          <PasswordStep onPending={setPending} />
        ) : (
          <TwoFactorFlow
            key={pending.pendingToken}
            pending={pending}
            calls={calls}
            onSignedIn={startSession}
            onRestart={() => {
              setPending(null);
            }}
          />
        )}
      </Card>
      <LanguagePicker />
    </main>
  );
}
