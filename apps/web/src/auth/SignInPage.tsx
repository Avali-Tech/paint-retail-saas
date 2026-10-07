import { Alert, Card, Tabs, TabsContent, TabsList, TabsTrigger } from '@paint/ui';
import { useState } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { PendingSignIn, SignInResult } from '../api/types.js';
import { useI18n } from '../i18n/i18n.js';
import { LanguagePicker } from '../i18n/LanguagePicker.js';
import { isSupportTab } from '../support-access/support-tab.js';
import { BrandMark } from '../theme/BrandMark.js';
import { useBranding } from '../theme/BrandingProvider.js';
import { useIdentity } from '../theme/IdentityProvider.js';
import { OtpSignIn } from './OtpSignIn.js';
import { PasswordSignIn } from './PasswordSignIn.js';
import { useSession, useStartSession } from './session.js';
import { SignInBusinessContext, useSignInBusiness } from './sign-in-business.js';
import { TwoFactorStep } from './TwoFactorStep.js';

/** Where to go after signing in: back to the page that asked, or home. */
export function returnPath(state: unknown): string {
  if (typeof state === 'object' && state !== null && 'from' in state) {
    const { from } = state;
    if (typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')) return from;
  }
  return '/';
}

export function SignInPage() {
  const { t } = useI18n();
  const { branding } = useBranding();
  const { logoSrc } = useIdentity();
  const { session, ended } = useSession();
  const startSession = useStartSession();
  const location = useLocation();
  const target = returnPath(location.state);
  const [method, setMethod] = useState('password');
  const [pending, setPending] = useState<PendingSignIn | null>(null);
  // Support views and refused support links keep the product's own look.
  const business = useSignInBusiness(
    session !== null || isSupportTab() || ended === 'support-rejected',
  );

  // Signing in starts the session, which re-renders this page into the redirect.
  if (session !== null) return <Navigate to={target} replace />;

  const onResult = (result: SignInResult) => {
    if ('twoFactor' in result) setPending(result.twoFactor);
    else startSession(result);
  };

  return (
    <main className="sign-in" id="main">
      <Card className="sign-in__card">
        <div className="sign-in__brand">
          <BrandMark appName={branding.appName} logoSrc={logoSrc} size="lg" />
          <h1 className="sign-in__title">{t('auth.title', { appName: branding.appName })}</h1>
          <p className="muted">{t('auth.subtitle')}</p>
        </div>
        {business.unknown && <Alert tone="warning">{t('branding.unknownLink')}</Alert>}
        {ended === 'expired' && <Alert tone="warning">{t('auth.expired')}</Alert>}
        {ended === 'signed-out' && <Alert tone="info">{t('auth.signedOut')}</Alert>}
        {ended === 'support-rejected' && <Alert tone="danger">{t('supportAccess.rejected')}</Alert>}
        <SignInBusinessContext value={business.slug}>
          {pending === null ? (
            <Tabs value={method} onValueChange={setMethod}>
              <TabsList aria-label={t('auth.methods')}>
                <TabsTrigger value="password">{t('auth.password')}</TabsTrigger>
                <TabsTrigger value="otp">{t('auth.otp')}</TabsTrigger>
              </TabsList>
              <TabsContent value="password">
                <PasswordSignIn onSignedIn={onResult} />
              </TabsContent>
              <TabsContent value="otp">
                <OtpSignIn onSignedIn={onResult} />
              </TabsContent>
            </Tabs>
          ) : (
            <TwoFactorStep
              key={pending.pendingToken}
              pending={pending}
              onSignedIn={startSession}
              onRestart={() => {
                setPending(null);
              }}
            />
          )}
        </SignInBusinessContext>
      </Card>
      <LanguagePicker />
    </main>
  );
}
