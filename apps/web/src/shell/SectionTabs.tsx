import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../i18n/i18n.js';
import { CountBadge, useBadgedName } from '../inbox/inbox-count.js';
import { rememberTab } from './last-tab.js';
import type { NavItem } from './nav.js';
import { SETTINGS_PATH, type Section } from './sections.js';

/**
 * Above every page: the tabs of its section (each its own address), or a way
 * back to the Settings page from a settings page. A section with one page has
 * no tabs. The tabs scroll sideways on a phone instead of wrapping.
 */
export function SectionTabs({
  section,
  current,
  badges,
}: {
  readonly section: Section | undefined;
  readonly current: NavItem | undefined;
  /** Counts on tabs, by the tab's key (the inbox's). */
  readonly badges: Readonly<Partial<Record<string, number>>>;
}) {
  const { t } = useI18n();
  const badgedName = useBadgedName();
  const nav = useRef<HTMLElement>(null);
  // On a phone the current tab can sit past the edge: bring it into view.
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }, [current]);

  if (section?.key === 'settings') {
    // Not on the Settings page itself.
    return current ? (
      <p className="shell__tabs shell__crumb">
        <Link to={SETTINGS_PATH}>← {t('nav.allSettings')}</Link>
      </p>
    ) : null;
  }
  if (!section || section.tabs.length < 2) return null;
  return (
    <nav ref={nav} className="shell__tabs section-nav" aria-label={t(section.label)}>
      {section.tabs.map((tab) => (
        <Link
          key={tab.key}
          to={tab.path}
          className="section-nav__link"
          aria-current={tab === current ? 'page' : undefined}
          aria-label={badgedName(t(tab.label), badges[tab.key] ?? 0)}
          // Remembered on the click too: a quick click elsewhere can come before the
          // shell renders this tab, and the section would then reopen at its first tab.
          onClick={() => {
            rememberTab(section.key, tab.path);
          }}
        >
          {t(tab.label)}
          <CountBadge count={badges[tab.key] ?? 0} />
        </Link>
      ))}
    </nav>
  );
}
