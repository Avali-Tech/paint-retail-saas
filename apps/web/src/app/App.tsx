import { ToastProvider } from '@paint/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router';
import { I18nProvider, useI18n } from '../i18n/i18n.js';
import { UpdateBanner } from '../pwa/UpdateBanner.js';
import type { UpdateController } from '../pwa/updates.js';
import { isSupportTab } from '../support-access/support-tab.js';
import { BrandingProvider } from '../theme/BrandingProvider.js';
import { IdentityProvider } from '../theme/IdentityProvider.js';
import { AppRoutes } from './routes.js';
import { ServicesProvider, useServices, type Services } from './services.js';
import { useSession } from '../auth/session.js';

/** The business's branding, loaded again whenever someone signs in. */
function SessionBranding({ children }: { readonly children: ReactNode }) {
  const { branding, identity } = useServices();
  const { session } = useSession();
  // A support view keeps the product's own look: it never loads (or caches) a business's
  // branding or logo before the support session is confirmed, so a forged link cannot restyle sign-in.
  const sessionKey = isSupportTab() ? null : (session?.token ?? null);
  return (
    <BrandingProvider source={branding} sessionKey={sessionKey}>
      <IdentityProvider source={identity} sessionKey={sessionKey}>
        {children}
      </IdentityProvider>
    </BrandingProvider>
  );
}

function Toasts({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  return (
    <ToastProvider regionLabel={t('common.messages')} dismissLabel={t('common.dismiss')}>
      {children}
    </ToastProvider>
  );
}

/** Every provider the app needs, around any router (tests use a MemoryRouter). */
export function AppProviders({
  services,
  children,
}: {
  readonly services: Services;
  readonly children: ReactNode;
}) {
  return (
    <ServicesProvider services={services}>
      <QueryClientProvider client={services.queryClient}>
        <I18nProvider>
          <SessionBranding>
            <Toasts>{children}</Toasts>
          </SessionBranding>
        </I18nProvider>
      </QueryClientProvider>
    </ServicesProvider>
  );
}

export interface AppProps {
  readonly services: Services;
  /** Offers a newly deployed version (production builds, which have a service worker). */
  readonly updates?: UpdateController | undefined;
}

export function App({ services, updates }: AppProps) {
  return (
    <StrictMode>
      <AppProviders services={services}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
        {updates && <UpdateBanner updates={updates} />}
      </AppProviders>
    </StrictMode>
  );
}
