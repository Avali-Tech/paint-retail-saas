import { Card, PageHeader } from '@paint/ui';
import { Link } from 'react-router';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { SETTINGS_GROUPS } from '../shell/nav.js';
import { visibleNav } from '../shell/sections.js';

/** /settings — every settings page the member may open, in groups. */
export function SettingsPage() {
  const { t } = useI18n();
  const can = usePermissions();
  const pages = visibleNav(can).flatMap((item) => (item.section === 'settings' ? [item] : []));
  return (
    <>
      <PageHeader title={t('nav.settings')} description={t('nav.settingsDescription')} />
      <div className="settings-hub">
        {SETTINGS_GROUPS.map((group) => {
          const links = pages.filter((page) => page.group === group);
          if (links.length === 0) return null;
          const headingId = `settings-${group}`;
          return (
            <Card key={group}>
              <section aria-labelledby={headingId}>
                <h2 id={headingId}>{t(`nav.settingsGroups.${group}`)}</h2>
                <ul className="settings-hub__list">
                  {links.map((page) => (
                    <li key={page.key}>
                      <Link to={page.path}>{t(page.label)}</Link>
                    </li>
                  ))}
                </ul>
              </section>
            </Card>
          );
        })}
      </div>
    </>
  );
}
