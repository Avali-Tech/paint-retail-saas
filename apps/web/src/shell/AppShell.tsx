import { Dialog, Icon, Spinner } from '@paint/ui';
import { Suspense, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useCurrentProfile, usePermissions, useSignOut } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { SupportBanner } from '../support-access/SupportBanner.js';
import { BrandMark } from '../theme/BrandMark.js';
import { useBranding } from '../theme/BrandingProvider.js';
import { useIdentity } from '../theme/IdentityProvider.js';
import { BOTTOM_BAR_SIZE, visibleNav, type NavItem } from './nav.js';
import { NotificationBell } from './NotificationBell.js';
import { SearchBox, useQuickActions } from './SearchBox.js';
import { useShortcuts } from './shortcuts.js';

function NavEntry({
  item,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly onNavigate?: () => void;
}) {
  const { t } = useI18n();
  return (
    <NavLink to={item.path} className="nav-link" onClick={onNavigate}>
      <Icon name={item.icon} />
      <span>{t(item.label)}</span>
    </NavLink>
  );
}

/**
 * The frame around every signed-in page: header with the business, search and
 * notifications; a side bar on wide screens and a bottom bar on phones, both
 * showing only the sections the member's role allows.
 */
export function AppShell() {
  const { t } = useI18n();
  const { branding } = useBranding();
  const { logoSrc } = useIdentity();
  const profile = useCurrentProfile();
  const can = usePermissions();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const items = visibleNav(can);
  const bar = items.slice(0, BOTTOM_BAR_SIZE);
  const overflow = items.slice(BOTTOM_BAR_SIZE);

  const actions = useQuickActions();
  useShortcuts(
    actions.data ?? [],
    () => searchRef.current?.focus(),
    (action) => {
      void navigate(action.path);
    },
  );

  const securityLink = (
    <NavLink
      to="/settings/security"
      className="nav-link"
      onClick={() => {
        setMoreOpen(false);
      }}
    >
      <Icon name="lock" />
      <span>{t('shell.security')}</span>
    </NavLink>
  );

  const signOutButton = (
    <button
      type="button"
      className="nav-link"
      onClick={() => {
        setMoreOpen(false);
        void signOut();
      }}
    >
      <Icon name="sign-out" />
      <span>{t('shell.signOut')}</span>
    </button>
  );

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {t('shell.skipToContent')}
      </a>
      <header className="shell__header">
        <div className="shell__brand">
          <BrandMark appName={branding.appName} logoSrc={logoSrc} />
          <div className="shell__names">
            <span className="shell__app-name">{branding.appName}</span>
            <span className="shell__business">{profile.organization.name}</span>
          </div>
        </div>
        <SearchBox inputRef={searchRef} />
        <NotificationBell />
      </header>

      <nav className="shell__sidebar" aria-label={t('shell.mainNav')}>
        <ul>
          {items.map((item) => (
            <li key={item.key}>
              <NavEntry item={item} />
            </li>
          ))}
        </ul>
        <div className="shell__account">
          <p className="muted">
            {t('shell.signedInAs', { name: profile.user.fullName, role: profile.role.name })}
          </p>
          {securityLink}
          {signOutButton}
        </div>
      </nav>

      <main className="shell__main" id="main" tabIndex={-1}>
        <SupportBanner />
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

      <nav className="shell__bottom-bar" aria-label={t('shell.mainNav')}>
        {bar.map((item) => (
          <NavEntry key={item.key} item={item} />
        ))}
        <button
          type="button"
          className="nav-link"
          aria-haspopup="dialog"
          onClick={() => {
            setMoreOpen(true);
          }}
        >
          <Icon name="more" />
          <span>{t('shell.more')}</span>
        </button>
      </nav>

      <Dialog
        open={moreOpen}
        onOpenChange={setMoreOpen}
        title={t('shell.more')}
        closeLabel={t('common.close')}
      >
        <ul className="more-list">
          {overflow.map((item) => (
            <li key={item.key}>
              <NavEntry
                item={item}
                onNavigate={() => {
                  setMoreOpen(false);
                }}
              />
            </li>
          ))}
          <li>{securityLink}</li>
          <li>{signOutButton}</li>
        </ul>
      </Dialog>
    </div>
  );
}
