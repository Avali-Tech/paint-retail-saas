import { ToastProvider } from '@paint/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router';
import { I18nProvider, useI18n } from '../i18n/i18n.js';
import { BrandingProvider } from '../theme/BrandingProvider.js';
import { AppRoutes } from './routes.js';
import { ServicesProvider, useServices, type Services } from './services.js';
import { useSession } from '../auth/session.js';

/** The business's branding, loaded again whenever someone signs in. */
function SessionBranding({ children }: { readonly children: ReactNode }) {
  const { branding } = useServices();
  const { session } = useSession();
  return (
    <BrandingProvider source={branding} sessionKey={session?.token ?? null}>
      {children}
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

export function App({ services }: { readonly services: Services }) {
  return (
    <StrictMode>
      <AppProviders services={services}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AppProviders>
    </StrictMode>
  );
}
