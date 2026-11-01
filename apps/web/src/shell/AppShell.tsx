import { Dialog, Icon, Spinner } from '@paint/ui';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useCurrentProfile, usePermissions, useSignOut } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { SubscriptionBanner } from '../billing/SubscriptionBanner.js';
import { SupportBanner } from '../support-access/SupportBanner.js';
import { BrandMark } from '../theme/BrandMark.js';
import { useBranding } from '../theme/BrandingProvider.js';
import { useIdentity } from '../theme/IdentityProvider.js';
import { CountBadge, useBadgedName, useInboxCount } from '../inbox/inbox-count.js';
import { readLastTabs, rememberTab } from './last-tab.js';
import { NotificationBell } from './NotificationBell.js';
import { SearchBox, useQuickActions } from './SearchBox.js';
import { SectionTabs } from './SectionTabs.js';
import {
  pageAt,
  phoneBar,
  sectionAt,
  sectionTarget,
  visibleSections,
  type Section,
} from './sections.js';
import { useShortcuts } from './shortcuts.js';

/** A menu entry: opens the section at its last-used tab and stays lit on all of its pages. */
function SectionEntry({
  section,
  active,
  className = 'nav-link',
  plus = false,
  badge = 0,
  onNavigate,
}: {
  readonly section: Section;
  readonly active: boolean;
  readonly className?: string;
  /** A "+" instead of the icon, for "+ New sale". */
  readonly plus?: boolean;
  /** What waits in the section (the inbox's count on Home). */
  readonly badge?: number;
  readonly onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const badgedName = useBadgedName();
  const navigate = useNavigate();
  const target = sectionTarget(section, readLastTabs());
  return (
    <Link
      to={target}
      className={className}
      aria-current={active ? 'true' : undefined}
      aria-label={badgedName(t(section.label), badge)}
      onClick={(event) => {
        // The tab used last may have changed since this link was drawn (a quick click).
        const latest = sectionTarget(section, readLastTabs());
        if (latest !== target) {
          event.preventDefault();
          void navigate(latest);
        }
        onNavigate?.();
      }}
    >
      {plus ? <span aria-hidden="true">+</span> : <Icon name={section.icon} />}
      <span>{t(section.label)}</span>
      <CountBadge count={badge} />
    </Link>
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
  const waiting = useInboxCount();
  /** The inbox's count shows on Home, where the inbox is. */
  const badgeOf = (section: Section) => (section.key === 'home' ? waiting : 0);

  const { pathname } = useLocation();
  const sections = visibleSections(can);
  const pages = sections.flatMap((section) => section.tabs);
  const current = pageAt(pathname, pages);
  const activeKey = sectionAt(pathname, pages);
  const active = sections.find((section) => section.key === activeKey);
  const newSale = sections.find((section) => section.key === 'newSale');
  const settings = sections.find((section) => section.key === 'settings');
  const menu = sections.filter((section) => section !== newSale && section !== settings);
  const { bar, more } = phoneBar(sections);
  const closeMore = () => {
    setMoreOpen(false);
  };

  // Clicking a section later reopens the tab used last.
  useEffect(() => {
    if (current) rememberTab(current.section, current.path);
  }, [current]);

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
        <div className="shell__menu">
          {newSale && (
            <SectionEntry
              section={newSale}
              active={activeKey === 'newSale'}
              className="shell__new-sale"
              plus
            />
          )}
          <ul>
            {menu.map((section) => (
              <li key={section.key}>
                <SectionEntry
                  section={section}
                  active={section.key === activeKey}
                  badge={badgeOf(section)}
                />
              </li>
            ))}
          </ul>
        </div>
        <div className="shell__account">
          {settings && <SectionEntry section={settings} active={activeKey === 'settings'} />}
          <p className="muted">
            {t('shell.signedInAs', { name: profile.user.fullName, role: profile.role.name })}
          </p>
          {securityLink}
          {signOutButton}
        </div>
      </nav>

      <main className="shell__main" id="main" tabIndex={-1}>
        <SupportBanner />
        <SubscriptionBanner />
        <SectionTabs section={active} current={current} badges={{ inbox: waiting }} />
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
        {bar.map((section) => (
          <SectionEntry
            key={section.key}
            section={section}
            active={section.key === activeKey}
            badge={badgeOf(section)}
          />
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
          {more.map((section) => (
            <li key={section.key}>
              <SectionEntry
                section={section}
                active={section.key === activeKey}
                badge={badgeOf(section)}
                onNavigate={closeMore}
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
