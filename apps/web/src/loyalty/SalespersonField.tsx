import { Field, Select } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';

/**
 * Who looks after a loyalty account: active team members (GET /members). Only
 * members who can see the team choose; for others this renders nothing and the
 * account starts without a salesperson.
 */
export function SalespersonField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (memberId: string) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const canChoose = usePermissions()('members:read');
  const people = useQuery({
    queryKey: ['members'],
    queryFn: ({ signal }) => api.loyalty.salespeople(signal),
    enabled: canChoose,
  });
  if (!canChoose) return null;
  return (
    <Field label={t('loyalty.salesperson')}>
      <Select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">{t('loyalty.noSalesperson')}</option>
        {(people.data ?? [])
          .filter((person) => person.isActive)
          .map((person) => (
            <option key={person.id} value={person.id}>
              {t('loyalty.salespersonOption', {
                name: person.user.fullName,
                role: person.role.name,
              })}
            </option>
          ))}
      </Select>
    </Field>
  );
}
