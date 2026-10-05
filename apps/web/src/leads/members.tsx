import { Field, Select } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Member } from '../api/types.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';

/**
 * Active team members (GET /members) for choosing who looks after a record.
 * Only members who can see the team get a list; for the rest it stays empty
 * and records go to whoever creates them.
 */
export function useMembers(): { readonly canChoose: boolean; readonly members: Member[] } {
  const api = useApi();
  const canChoose = usePermissions()('members:read');
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api.members.list(),
    enabled: canChoose,
  });
  return { canChoose, members: (members.data ?? []).filter((member) => member.isActive) };
}

/** The "Assigned to" filter: anyone, me, or (for those who can see the team) one person. */
export function AssigneeFilter({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const { members } = useMembers();
  return (
    <Field label={t('crm.assignedTo')}>
      <Select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">{t('crm.anyone')}</option>
        <option value="me">{t('crm.me')}</option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>
            {member.user.fullName}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Who looks after a new record; renders nothing for members who cannot see the team. */
export function MemberField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (memberId: string) => void;
}) {
  const { t } = useI18n();
  const { canChoose, members } = useMembers();
  if (!canChoose) return null;
  return (
    <Field label={t('crm.assignedTo')} hint={t('crm.assignHint')}>
      <Select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">{t('crm.me')}</option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>
            {t('crm.memberOption', { name: member.user.fullName, role: member.role.name })}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Hands a record to someone else. */
export function AssignDialog({
  title,
  current,
  onSubmit,
  onClose,
}: {
  readonly title: string;
  readonly current: string;
  readonly onSubmit: (memberId: string) => Promise<unknown>;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const { members } = useMembers();
  const [memberId, setMemberId] = useState(current);
  return (
    <FormDialog
      open
      onClose={onClose}
      title={title}
      submitLabel={t('crm.assign')}
      onSubmit={async () => {
        await onSubmit(memberId);
        return undefined;
      }}
    >
      <Field label={t('crm.assignedTo')}>
        <Select
          value={memberId}
          onChange={(event) => {
            setMemberId(event.target.value);
          }}
        >
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {t('crm.memberOption', { name: member.user.fullName, role: member.role.name })}
            </option>
          ))}
        </Select>
      </Field>
    </FormDialog>
  );
}
