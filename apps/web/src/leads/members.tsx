import { Field, Select } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { AssignableMember, AssignmentQuery, Member } from '../api/team.js';
import { useApi } from '../app/services.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { membersKey } from '../team/team-data.js';

/**
 * Who a record can be handed to (GET /members/assignable): active people whose
 * role handles it and who work at its store. Anyone who may create such records
 * can ask, without seeing the team.
 */
export function useAssignees(query: AssignmentQuery): AssignableMember[] {
  const api = useApi();
  const assignees = useQuery({
    queryKey: ['assignable', query],
    queryFn: ({ signal }) => api.team.assignable(query, signal),
  });
  return assignees.data ?? [];
}

/**
 * Active colleagues (GET /members, shared with the team screens) for the
 * "Assigned to" list filters: only members who can see the team get a list.
 */
function useColleagues(): Member[] {
  const api = useApi();
  const { memberId } = useCurrentProfile();
  const canSeeTeam = usePermissions()('members:read');
  const members = useQuery({
    queryKey: membersKey,
    queryFn: ({ signal }) => api.team.members(signal),
    enabled: canSeeTeam,
  });
  return (members.data ?? []).filter((member) => member.isActive && member.id !== memberId);
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
  const members = useColleagues();
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

/**
 * Who looks after a new record: "Me" (the default) or a colleague who may take
 * it at its store. Renders nothing while there is no one else to choose.
 */
export function MemberField({
  value,
  onChange,
  assignment,
}: {
  readonly value: string;
  readonly onChange: (memberId: string) => void;
  readonly assignment: AssignmentQuery;
}) {
  const { t } = useI18n();
  const { memberId } = useCurrentProfile();
  const others = useAssignees(assignment).filter((member) => member.id !== memberId);
  if (others.length === 0) return null;
  return (
    <Field label={t('crm.assignedTo')} hint={t('crm.assignHint')}>
      <Select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">{t('crm.me')}</option>
        {others.map((member) => (
          <option key={member.id} value={member.id}>
            {t('crm.memberOption', { name: member.name, role: member.role })}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Hands a record to someone else who may take it at its store. */
export function AssignDialog({
  title,
  current,
  assignment,
  onSubmit,
  onClose,
}: {
  readonly title: string;
  readonly current: string;
  readonly assignment: AssignmentQuery;
  readonly onSubmit: (memberId: string) => Promise<unknown>;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const members = useAssignees(assignment);
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
              {t('crm.memberOption', { name: member.name, role: member.role })}
            </option>
          ))}
        </Select>
      </Field>
    </FormDialog>
  );
}
