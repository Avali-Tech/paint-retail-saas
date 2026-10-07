import type { Permission } from '@paint/shared';
import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router';
import { usePermissions } from '../auth/session.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';

export interface SectionLink {
  readonly to: string;
  readonly label: MessageKey;
  readonly permission: Permission;
}

/**
 * Links between the screens of one section (e.g. stock, low stock, transfers),
 * scrolling sideways on a phone instead of wrapping.
 */
export function SectionNav({
  label,
  links,
}: {
  readonly label: MessageKey;
  readonly links: readonly SectionLink[];
}) {
  const { t } = useI18n();
  const can = usePermissions();
  const nav = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  // On a phone the current screen's link can sit past the edge: bring it into view.
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }, [pathname]);
  return (
    <nav ref={nav} className="section-nav" aria-label={t(label)}>
      {links
        .filter((link) => can(link.permission))
        .map((link) => (
          <NavLink key={link.to} to={link.to} end className="section-nav__link">
            {t(link.label)}
          </NavLink>
        ))}
    </nav>
  );
}
