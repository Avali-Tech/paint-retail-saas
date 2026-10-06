import {
  Badge,
  Card,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Select,
  Table,
  buttonStyle,
} from '@paint/ui';
import { Link } from 'react-router';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { SectionNav, type SectionLink } from '../lib/SectionNav.js';
import { useStores } from '../stock/stores.js';
import { matchesSearch, storeSummary, useMembers } from './team-data.js';

/** Members and roles: the two screens of the team section. */
export const TEAM_LINKS: readonly SectionLink[] = [
  { to: '/team', label: 'team.members', permission: 'members:read' },
  { to: '/team/roles', label: 'roles.title', permission: 'members:read' },
];

const FILTERS = ['q', 'status'] as const;
const STATUSES = ['active', 'inactive', 'all'] as const;

/** /team — everyone the member can see, with role, stores, status and two-factor sign-in. */
export function TeamPage() {
  const i18n = useI18n();
  const { t } = i18n;
  const can = usePermissions();
  const profile = useCurrentProfile();
  const filters = useUrlFilters(FILTERS);
  const status = STATUSES.find((value) => value === filters.values.status) ?? 'active';
  const members = useMembers();
  const stores = useStores();

  return (
    <>
      <PageHeader
        title={t('team.title')}
        description={t('team.description')}
        actions={
          can('members:manage') ? (
            <Link to="/team/new" {...buttonStyle('primary')}>
              {t('team.add')}
            </Link>
          ) : undefined
        }
      />
      <SectionNav label="team.sections" links={TEAM_LINKS} />
      <Card>
        <div className="filters">
          <Field label={t('team.search')} className="filters__search">
            <Input
              type="search"
              value={filters.values.q}
              placeholder={t('team.searchPlaceholder')}
              onChange={(event) => {
                filters.set('q', event.target.value);
              }}
            />
          </Field>
          <Field label={t('team.status')}>
            <Select
              value={status}
              onChange={(event) => {
                filters.set('status', event.target.value);
              }}
            >
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`team.statuses.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <QueryState query={members} error="team.error">
          {(all) => {
            const shown = all.filter(
              (member) =>
                (status === 'all' || member.isActive === (status === 'active')) &&
                matchesSearch(member, filters.values.q),
            );
            return shown.length === 0 ? (
              <EmptyState icon={<Icon name="customers" size={32} />} title={t('team.empty')} />
            ) : (
              <Table label={t('team.list')}>
                <thead>
                  <tr>
                    <th scope="col">{t('team.name')}</th>
                    <th scope="col">{t('team.role')}</th>
                    <th scope="col">{t('team.stores')}</th>
                    <th scope="col">{t('team.status')}</th>
                    <th scope="col">{t('team.twoFactor')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((member) => (
                    <tr key={member.id}>
                      <th scope="row">
                        <Link to={`/team/${member.id}`}>{member.user.fullName}</Link>
                        {member.user.id === profile.user.id && (
                          <>
                            {' '}
                            <Badge tone="primary">{t('team.you')}</Badge>
                          </>
                        )}
                        <span className="cell-meta">{member.user.phone ?? member.user.email}</span>
                      </th>
                      <td>{member.role.name}</td>
                      <td>{storeSummary(member, stores.data ?? [], i18n)}</td>
                      <td>
                        <Badge tone={member.isActive ? 'success' : 'neutral'}>
                          {member.isActive ? t('team.active') : t('team.inactive')}
                        </Badge>
                      </td>
                      <td>
                        <Badge tone={member.twoFactorEnabled ? 'success' : 'neutral'}>
                          {member.twoFactorEnabled ? t('team.on') : t('team.off')}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            );
          }}
        </QueryState>
      </Card>
    </>
  );
}
