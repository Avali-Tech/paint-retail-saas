import { DEFAULT_BRANDING } from '@paint/shared';
import { Button, Icon, Spinner } from '@paint/ui';
import { Suspense, useLayoutEffect, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { useI18n } from '../i18n/i18n.js';
import { useBranding } from '../theme/BrandingProvider.js';
import { PLATFORM_NAV_ITEMS } from './nav.js';
import { usePlatformSession, usePlatformSignOut } from './session.js';

/**
 * The console always shows the product's own look, never the branding of a
 * business someone on this device signed in to; leaving the console restores it.
 */
export function useDefaultTheme(): void {
  const { preview } = useBranding();
  useLayoutEffect(() => {
    preview(DEFAULT_BRANDING);
    return () => {
      preview(null);
    };
  }, [preview]);
}

/** Console pages: operators who are not signed in go to the console's own sign-in. */
export function RequirePlatformAuth({ children }: { readonly children: ReactNode }) {
  const { session, ended } = usePlatformSession();
  const location = useLocation();
  if (session === null) {
    const state = ended === 'signed-out' ? null : { from: location.pathname + location.search };
    return <Navigate to="/platform/sign-in" replace state={state} />;
  }
  return children;
}

/** A plain frame marked "Platform console", separate from a business's shell. */
export function PlatformLayout() {
  const { t } = useI18n();
  useDefaultTheme();
  const signOut = usePlatformSignOut();
  return (
    <div className="platform">
      <a className="skip-link" href="#main">
        {t('platform.skipToContent')}
      </a>
      <header className="platform__header">
        <div className="platform__brand">
          <span className="brand-mark" aria-hidden="true">
            {t('platform.console').slice(0, 1)}
          </span>
          <div className="platform__names">
            <p className="platform__title">{t('platform.console')}</p>
            <span className="platform__hint">{t('platform.consoleHint')}</span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void signOut();
          }}
        >
          <Icon name="sign-out" />
          {t('platform.signOut')}
        </Button>
      </header>
      <nav className="section-nav platform__nav" aria-label={t('platform.nav')}>
        {PLATFORM_NAV_ITEMS.map((item) => (
          <NavLink key={item.path} to={item.path} className="section-nav__link">
            {t(item.label)}
          </NavLink>
        ))}
      </nav>
      <main className="platform__main" id="main" tabIndex={-1}>
        <Suspense
          fallback={
            <div className="query-state">
              <Spinner label={t('common.loading')} />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
