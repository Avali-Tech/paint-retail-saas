import type { Permission } from '@paint/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  useToast,
} from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import type { Role } from '../api/team.js';
import { useApi } from '../app/services.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { rolesKey, useRoles } from '../team/team-data.js';
import { AREA_LABELS, PERMISSION_GROUPS, PERMISSION_LABELS } from './permission-groups.js';
import './roles.css';

/** What is wrong with a role before saving it; empty when it can be saved. */
export function roleProblems(
  name: string,
  permissions: readonly Permission[],
): { name?: 'roles.form.nameInvalid'; permissions?: 'roles.form.permissionsRequired' } {
  const length = name.trim().length;
  return {
    ...(length < 2 || length > 60 ? { name: 'roles.form.nameInvalid' as const } : {}),
    ...(permissions.length === 0 ? { permissions: 'roles.form.permissionsRequired' as const } : {}),
  };
}

/** The role's name and its permissions, ticked by area; read-only for system roles. */
function RoleForm({ role }: { readonly role: Role | null }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const can = usePermissions();
  const profile = useCurrentProfile();
  const hintId = useId();
  const [name, setName] = useState(role?.name ?? '');
  const [chosen, setChosen] = useState<readonly Permission[]>(role?.permissions ?? []);
  const [problems, setProblems] = useState<ReturnType<typeof roleProblems>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const system = role?.isSystem === true;
  const editable = can('roles:manage') && !system;

  const toggle = (permission: Permission, on: boolean) => {
    setChosen(on ? [...chosen, permission] : chosen.filter((value) => value !== permission));
  };

  const save = async () => {
    const found = roleProblems(name, chosen);
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    setMessage(null);
    setSaving(true);
    try {
      const input = { name: name.trim(), permissions: chosen };
      const saved =
        role === null
          ? await api.team.createRole(input)
          : await api.team.updateRole(role.id, input);
      await queryClient.invalidateQueries({ queryKey: rolesKey });
      if (role === null) {
        toast({ title: t('roles.form.created', { name: saved.name }), tone: 'success' });
        void navigate(`/team/roles/${saved.id}`, { replace: true });
      } else {
        toast({ title: t('roles.form.saved'), tone: 'success' });
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <PageHeader
        title={role === null ? t('roles.form.newTitle') : role.name}
        description={
          role === null ? t('roles.form.newDescription') : t('roles.form.editDescription')
        }
        actions={
          <div className="row">
            {role !== null && (
              <Badge tone={system ? 'neutral' : 'primary'}>
                {system ? t('roles.system') : t('roles.custom')}
              </Badge>
            )}
            <Link to="/team/roles">{t('roles.form.back')}</Link>
          </div>
        }
      />
      {system && <Alert tone="info">{t('roles.form.system')}</Alert>}
      {!system && !editable && <Alert tone="info">{t('roles.form.readOnly')}</Alert>}
      {message !== null && <Alert tone="danger">{message}</Alert>}
      <Card>
        <Field
          label={t('roles.form.name')}
          error={problems.name === undefined ? undefined : t(problems.name)}
          required
        >
          <Input
            value={name}
            readOnly={!editable}
            maxLength={60}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
      </Card>
      <Card title={t('roles.form.permissions')}>
        <div className="stack">
          {editable && (
            <p id={hintId} className="muted">
              {t('roles.form.notHeld')}
            </p>
          )}
          {problems.permissions !== undefined && (
            <Alert tone="danger">{t(problems.permissions)}</Alert>
          )}
          <div className="permission-groups">
            {PERMISSION_GROUPS.map((group) => (
              <fieldset key={group.area} className="permission-group">
                <legend>{t(AREA_LABELS[group.area])}</legend>
                {group.permissions.map((permission) => {
                  const held = profile.permissions.includes(permission);
                  return (
                    <Checkbox
                      key={permission}
                      label={t(PERMISSION_LABELS[permission])}
                      checked={chosen.includes(permission)}
                      // Nobody can give what they do not hold (the API refuses it too).
                      disabled={!editable || !held}
                      aria-describedby={editable && !held ? hintId : undefined}
                      onChange={(event) => {
                        toggle(permission, event.target.checked);
                      }}
                    />
                  );
                })}
              </fieldset>
            ))}
          </div>
        </div>
      </Card>
      {editable && (
        <div className="row">
          <Button type="submit" loading={saving}>
            {role === null ? t('roles.form.create') : t('roles.form.save')}
          </Button>
        </div>
      )}
    </form>
  );
}

/** /team/roles/new — a custom role. */
export function NewRolePage() {
  return <RoleForm role={null} />;
}

/** /team/roles/:id — a role's permissions; custom roles can be changed. */
export function RolePage() {
  const { t } = useI18n();
  // The route always has an :id.
  const id = String(useParams().id);
  const roles = useRoles();
  return (
    <QueryState query={roles} error="roles.error">
      {(list) => {
        const role = list.find((candidate) => candidate.id === id);
        return role === undefined ? (
          <EmptyState
            icon={<Icon name="lock" size={32} />}
            title={t('roles.notFound')}
            action={<Link to="/team/roles">{t('roles.form.back')}</Link>}
          />
        ) : (
          // Keyed by what was saved, so the form starts again from the saved role.
          <RoleForm key={`${role.name}:${role.permissions.join()}`} role={role} />
        );
      }}
    </QueryState>
  );
}
