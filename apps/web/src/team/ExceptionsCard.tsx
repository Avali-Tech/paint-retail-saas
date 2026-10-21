import type { Permission, PermissionExceptions } from '@paint/shared';
import { Alert, Button, Card, Select, useToast } from '@paint/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/errors.js';
import type { Member } from '../api/team.js';
import { useApi } from '../app/services.js';
import { useCurrentProfile } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { AREA_LABELS, PERMISSION_GROUPS, PERMISSION_LABELS } from '../roles/permission-groups.js';
import { membersKey, useRoles } from './team-data.js';
import '../roles/roles.css';

/** For each permission: as the role says, or allowed or denied for this person. */
export type ExceptionChoice = 'role' | 'allow' | 'deny';

export function choiceOf(
  exceptions: PermissionExceptions,
  permission: Permission,
): ExceptionChoice {
  if (exceptions.granted.includes(permission)) return 'allow';
  return exceptions.denied.includes(permission) ? 'deny' : 'role';
}

/** The exceptions with `permission` set to `choice`. */
export function withChoice(
  exceptions: PermissionExceptions,
  permission: Permission,
  choice: ExceptionChoice,
): PermissionExceptions {
  const granted = exceptions.granted.filter((p) => p !== permission);
  const denied = exceptions.denied.filter((p) => p !== permission);
  if (choice === 'allow') granted.push(permission);
  if (choice === 'deny') denied.push(permission);
  return { granted: granted.sort(), denied: denied.sort() };
}

/**
 * A member's own exceptions to their role, permission by permission. Owners
 * have none. Nobody can allow what they do not hold (the API refuses it too).
 */
export function ExceptionsCard({
  member,
  editable,
}: {
  readonly member: Member;
  readonly editable: boolean;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const profile = useCurrentProfile();
  const roles = useRoles();
  const [exceptions, setExceptions] = useState(member.exceptions);
  const save = useMutation({
    mutationFn: () => api.team.updateMember(member.id, { exceptions }),
    onSuccess: async (updated) => {
      queryClient.setQueryData([...membersKey, member.id], updated);
      await queryClient.invalidateQueries({ queryKey: membersKey, exact: true });
      toast({ title: t('team.member.exceptions.saved'), tone: 'success' });
    },
  });
  const title = t('team.member.exceptions.title');

  if (member.role.key === 'owner') {
    return (
      <Card title={title}>
        <p>{t('team.member.exceptions.owner')}</p>
      </Card>
    );
  }
  const fromRole = roles.data?.find((role) => role.id === member.role.id)?.permissions ?? [];
  return (
    <Card title={title}>
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <p className="muted">
          {t('team.member.exceptions.description', { name: member.user.fullName })}
        </p>
        <p>
          {t('team.member.exceptions.count', {
            granted: String(exceptions.granted.length),
            denied: String(exceptions.denied.length),
          })}
        </p>
        {save.isError && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
        <div className="permission-groups">
          {PERMISSION_GROUPS.map((group) => (
            <fieldset key={group.area} className="permission-group">
              <legend>{t(AREA_LABELS[group.area])}</legend>
              {group.permissions.map((permission) => {
                const label = t(PERMISSION_LABELS[permission]);
                return (
                  <label key={permission} className="exception-row">
                    <span>{label}</span>
                    <Select
                      aria-label={label}
                      value={choiceOf(exceptions, permission)}
                      disabled={!editable}
                      onChange={(event) => {
                        setExceptions(
                          withChoice(exceptions, permission, event.target.value as ExceptionChoice),
                        );
                      }}
                    >
                      <option value="role">
                        {fromRole.includes(permission)
                          ? t('team.member.exceptions.asRoleYes')
                          : t('team.member.exceptions.asRoleNo')}
                      </option>
                      <option value="allow" disabled={!profile.permissions.includes(permission)}>
                        {t('team.member.exceptions.allow')}
                      </option>
                      <option value="deny">{t('team.member.exceptions.deny')}</option>
                    </Select>
                  </label>
                );
              })}
            </fieldset>
          ))}
        </div>
        {editable && (
          <div className="row">
            <Button type="submit" loading={save.isPending}>
              {t('team.member.exceptions.save')}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
