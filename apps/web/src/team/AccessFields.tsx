import { Checkbox, Field, Select } from '@paint/ui';
import { useId } from 'react';
import type { Role } from '../api/team.js';
import type { Profile } from '../api/types.js';
import { useCurrentProfile } from '../auth/session.js';
import { useI18n, type I18n } from '../i18n/i18n.js';
import { storeLabel } from '../stock/StoreSelect.js';
import { useStores } from '../stock/stores.js';
import { useRoles } from './team-data.js';

/** A member's role and stores, as the access form holds them. */
export interface Access {
  readonly roleId: string;
  readonly allStores: boolean;
  readonly storeIds: readonly string[];
}

export interface AccessErrors {
  readonly role?: string;
  readonly stores?: string;
}

/**
 * Roles the viewer may hand out: nothing with permissions they lack, and owner
 * only from an owner (the API refuses the rest, and says why). `keep` stays
 * listed so a member's current role shows even when the viewer could not give it.
 */
export function grantableRoles(roles: readonly Role[], viewer: Profile, keep: string): Role[] {
  return roles.filter(
    (role) =>
      role.id === keep ||
      ((role.key !== 'owner' || viewer.role.key === 'owner') &&
        role.permissions.every((permission) => viewer.permissions.includes(permission))),
  );
}

/** What is wrong with the access before sending it; empty when it can be sent. */
export function accessProblems(access: Access, t: I18n['t']): AccessErrors {
  return {
    ...(access.roleId === '' ? { role: t('team.form.roleRequired') } : {}),
    ...(!access.allStores && access.storeIds.length === 0
      ? { stores: t('team.form.storesRequired') }
      : {}),
  };
}

/**
 * Role, all-store access and the stores to work at. Only stores the viewer can
 * access are offered, and all-store access only by someone who has it.
 */
export function AccessFields({
  value,
  onChange,
  errors,
  currentRoleId,
  disabled,
}: {
  readonly value: Access;
  readonly onChange: (access: Access) => void;
  readonly errors: AccessErrors;
  /** The member's role now, listed even if the viewer could not give it ("" for a new member). */
  readonly currentRoleId: string;
  readonly disabled: boolean;
}) {
  const { t } = useI18n();
  const errorId = useId();
  const profile = useCurrentProfile();
  const roles = useRoles();
  const stores = useStores();
  const open = (stores.data ?? []).filter(
    (store) => store.isActive || value.storeIds.includes(store.id),
  );
  const toggleStore = (storeId: string, on: boolean) => {
    onChange({
      ...value,
      storeIds: on ? [...value.storeIds, storeId] : value.storeIds.filter((id) => id !== storeId),
    });
  };

  return (
    <>
      <Field label={t('team.form.role')} error={errors.role} required>
        <Select
          value={value.roleId}
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...value, roleId: event.target.value });
          }}
        >
          <option value="">{t('team.form.chooseRole')}</option>
          {grantableRoles(roles.data ?? [], profile, currentRoleId).map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset
        className="checkbox-grid"
        aria-describedby={errors.stores === undefined ? undefined : errorId}
      >
        <legend className="ui-field__label">{t('team.form.access')}</legend>
        {/* Only someone with all-store access may give it; others see that it is set. */}
        {!profile.allStores && value.allStores && <p>{t('team.allStores')}</p>}
        {profile.allStores && (
          <Checkbox
            label={t('team.form.allStores')}
            checked={value.allStores}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...value, allStores: event.target.checked });
            }}
          />
        )}
        {!value.allStores &&
          open.map((store) => (
            <Checkbox
              key={store.id}
              label={storeLabel(store)}
              checked={value.storeIds.includes(store.id)}
              disabled={disabled}
              onChange={(event) => {
                toggleStore(store.id, event.target.checked);
              }}
            />
          ))}
        {errors.stores !== undefined && (
          <p id={errorId} className="ui-field__error">
            {errors.stores}
          </p>
        )}
      </fieldset>
    </>
  );
}
