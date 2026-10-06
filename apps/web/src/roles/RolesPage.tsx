import { PERMISSIONS } from '@paint/shared';
import { Badge, Card, PageHeader, Table, buttonStyle } from '@paint/ui';
import { Link } from 'react-router';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { SectionNav } from '../lib/SectionNav.js';
import { TEAM_LINKS } from '../team/TeamPage.js';
import { useRoles } from '../team/team-data.js';

/** /team/roles — system and custom roles with how much each may do. */
export function RolesPage() {
  const { t } = useI18n();
  const can = usePermissions();
  const roles = useRoles();
  return (
    <>
      <PageHeader
        title={t('roles.title')}
        description={t('roles.description')}
        actions={
          can('roles:manage') ? (
            <Link to="/team/roles/new" {...buttonStyle('primary')}>
              {t('roles.add')}
            </Link>
          ) : undefined
        }
      />
      <SectionNav label="team.sections" links={TEAM_LINKS} />
      <Card>
        <QueryState query={roles} error="roles.error">
          {(list) => (
            <Table label={t('roles.list')}>
              <thead>
                <tr>
                  <th scope="col">{t('roles.name')}</th>
                  <th scope="col">{t('roles.type')}</th>
                  <th scope="col">{t('roles.permissions')}</th>
                  <th scope="col">{t('roles.members')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((role) => (
                  <tr key={role.id}>
                    <th scope="row">
                      <Link to={`/team/roles/${role.id}`}>{role.name}</Link>
                    </th>
                    <td>
                      <Badge tone={role.isSystem ? 'neutral' : 'primary'}>
                        {role.isSystem ? t('roles.system') : t('roles.custom')}
                      </Badge>
                    </td>
                    <td>
                      {t('roles.permissionCount', {
                        count: role.permissions.length,
                        total: PERMISSIONS.length,
                      })}
                    </td>
                    <td>{role.memberCount}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryState>
      </Card>
    </>
  );
}
