import { Field, Select } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../app/services.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { membersKey } from '../team/team-data.js';

// Report filters that pick one of the business's brands, categories or team members
// (the sales reports, MVP 3 round 7b). Each lists "Any" first; "" leaves the filter out.

interface Choice {
  readonly id: string;
  readonly name: string;
}

interface PickProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (id: string) => void;
}

function Pick({ label, value, onChange, choices }: PickProps & { readonly choices: Choice[] }) {
  const { t } = useI18n();
  return (
    <Field label={label}>
      <Select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">{t('reports.any')}</option>
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function BrandFilter(props: PickProps) {
  const api = useApi();
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api.catalog.brands() });
  return <Pick {...props} choices={brands.data ?? []} />;
}

export function CategoryFilter(props: PickProps) {
  const api = useApi();
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.catalog.categories(),
  });
  return <Pick {...props} choices={categories.data ?? []} />;
}

/** The team for those who may see it (GET /members); otherwise just the member themself. */
export function MemberFilter(props: PickProps) {
  const api = useApi();
  const { t } = useI18n();
  const profile = useCurrentProfile();
  const canSeeTeam = usePermissions()('members:read');
  const members = useQuery({
    queryKey: membersKey,
    queryFn: ({ signal }) => api.team.members(signal),
    enabled: canSeeTeam,
  });
  const choices = canSeeTeam
    ? (members.data ?? []).map((member) => ({ id: member.id, name: member.user.fullName }))
    : [{ id: profile.memberId, name: t('crm.me') }];
  return <Pick {...props} choices={choices} />;
}
