import { PERMISSIONS, type Permission } from '@paint/shared';
import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../auth/auth-context.js';
import { sampleAuth } from '../test-support/sample-auth.js';
import { roleChangeProblem, rolePermissionsProblem } from './role-rules.js';

const manager = (roleKey: string, permissions: readonly Permission[]): AuthContext => ({
  ...sampleAuth,
  role: { key: roleKey, name: roleKey },
  permissions: new Set(permissions),
});

const owner = manager('owner', PERMISSIONS);
const lead = manager('custom_lead', ['roles:manage', 'stores:read', 'members:read']);
const custom = (permissions: Permission[], key = 'custom_cashier') => ({
  key,
  isSystem: false,
  permissions,
});

describe('rolePermissionsProblem', () => {
  it('allows permissions the manager holds, and refuses any other', () => {
    expect(rolePermissionsProblem(lead, ['stores:read'])).toBeNull();
    expect(rolePermissionsProblem(lead, ['stores:read', 'catalog:read'])).toBe(
      'You cannot give permissions you do not have',
    );
  });
});

describe('roleChangeProblem', () => {
  it('lets an owner change any custom role', () => {
    expect(roleChangeProblem(owner, custom(['catalog:read']), [...PERMISSIONS])).toBeNull();
    expect(roleChangeProblem(owner, custom(['catalog:read']), undefined)).toBeNull();
  });

  it('never changes a system role', () => {
    expect(roleChangeProblem(owner, { ...custom([]), isSystem: true }, undefined)).toBe(
      'System roles cannot be changed',
    );
  });

  it('never changes the role the manager holds', () => {
    expect(roleChangeProblem(lead, custom(['stores:read'], 'custom_lead'), undefined)).toBe(
      'You cannot change your own role',
    );
  });

  it('refuses a role that grants more than the manager has', () => {
    expect(roleChangeProblem(lead, custom(['catalog:read']), ['stores:read'])).toBe(
      'This role has permissions you are not allowed to manage',
    );
  });

  it('refuses new permissions the manager lacks', () => {
    expect(roleChangeProblem(lead, custom(['stores:read']), ['catalog:read'])).toBe(
      'You cannot give permissions you do not have',
    );
    expect(roleChangeProblem(lead, custom(['stores:read']), ['members:read'])).toBeNull();
  });
});
