import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import {
  addAuthenticator,
  call,
  createBusiness,
  openFromMenu,
  PASSWORD,
  signInWithPassword,
  type Business,
  uniquePhone,
} from './support.js';

// The team: members with their roles, stores, status and two-factor sign-in,
// and roles with their permissions.

const openTeam = async (page: Page) => {
  await openFromMenu(page, 'Settings', 'Team & roles');
  await expect(page.getByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
};

const roleId = async (business: Business, key: string) => {
  const roles = await call<{ id: string; key: string }[]>('GET', '/roles', {
    token: business.token,
  });
  return String(roles.find((role) => role.key === key)?.id);
};

test('an owner adds a member, changes their access, deactivates and reactivates them', async ({
  page,
}) => {
  const business = await createBusiness('Team Paints');
  await signInWithPassword(page, business.ownerPhone);
  await openTeam(page);
  await expect(
    page.getByRole('row', { name: /Anil Owner You/ }).getByRole('cell', { name: 'All stores' }),
  ).toBeVisible();
  await expectUsable(page);

  await page.getByRole('link', { name: '+ Team member' }).click();
  await expect(page.getByRole('heading', { name: 'Add a team member', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Add member' }).click();
  await expect(page.getByText('Enter a mobile number or an email address')).toBeVisible();
  await expectUsable(page);

  const phone = uniquePhone();
  await page.getByRole('textbox', { name: 'Full name' }).fill('Ravi Teja');
  await page.getByRole('textbox', { name: 'Mobile number' }).fill(phone.slice(3));
  await page.getByRole('combobox', { name: 'Role' }).selectOption('Store Employee');
  await page.getByRole('checkbox', { name: 'HYD · Hyderabad' }).check();
  await page.getByRole('button', { name: 'Add member' }).click();
  await expect(page.getByText('Ravi Teja is now on the team')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ravi Teja', level: 1 })).toBeVisible();
  await expectUsable(page);

  const access = page.getByRole('region', { name: 'Role and stores' });
  await access.getByRole('combobox', { name: 'Role' }).selectOption('Branch Manager');
  await access.getByRole('checkbox', { name: 'PUN · Pune' }).check();
  await access.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Changes saved')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Contact' })).toContainText('HYD, PUN');

  const status = page.getByRole('region', { name: 'Status' });
  await status.getByRole('button', { name: 'Deactivate' }).click();
  const dialog = page.getByRole('dialog', { name: 'Deactivate Ravi Teja?' });
  await expectUsable(page);
  await dialog.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByText('Ravi Teja deactivated')).toBeVisible();
  await expect(status.getByText('Inactive')).toBeVisible();

  await openTeam(page);
  await expect(page.getByRole('link', { name: 'Ravi Teja' })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Status' }).selectOption('Inactive');
  await page.getByRole('link', { name: 'Ravi Teja' }).click();
  await page
    .getByRole('region', { name: 'Status' })
    .getByRole('button', { name: 'Reactivate' })
    .click();
  await expect(page.getByText('Ravi Teja reactivated')).toBeVisible();

  const members = await call<
    { user: { fullName: string }; role: { key: string }; isActive: boolean }[]
  >('GET', '/members', { token: business.token });
  expect(members.find((member) => member.user.fullName === 'Ravi Teja')).toMatchObject({
    role: { key: 'branch_manager' },
    isActive: true,
  });
});

test('an owner resets a member’s two-factor sign-in from the team', async ({ page }) => {
  const business = await createBusiness('Reset Paints');
  const phone = uniquePhone();
  await call('POST', '/members', {
    token: business.token,
    body: {
      fullName: 'Suresh Counter',
      phone,
      password: PASSWORD,
      roleId: await roleId(business, 'store_employee'),
      storeIds: [business.stores[0]?.id],
    },
  });
  const { token } = await call<{ token: string }>('POST', '/auth/login', {
    body: { identifier: phone, password: PASSWORD },
  });
  await addAuthenticator(phone, token);

  await signInWithPassword(page, business.ownerPhone);
  await openTeam(page);
  const row = page.getByRole('row', { name: /Suresh Counter/ });
  await expect(row.getByRole('cell', { name: 'On' })).toBeVisible();
  await row.getByRole('link', { name: 'Suresh Counter' }).click();

  const card = page.getByRole('region', { name: 'Two-factor sign-in' });
  await card.getByRole('button', { name: 'Reset two-factor' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reset two-factor sign-in for Suresh Counter?' });
  await dialog.getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByText('Two-factor sign-in reset for Suresh Counter')).toBeVisible();
  await expect(card.getByText('Off', { exact: true })).toBeVisible();
  await expectUsable(page);

  // Their session ended with the reset.
  await expect(call('GET', '/auth/me', { token })).rejects.toThrow(/401/);

  // Account security points owners here instead of keeping a second reset list.
  await page.goto('/settings/security');
  await page
    .getByRole('region', { name: 'Team two-factor sign-in' })
    .getByRole('link', { name: 'Open the team' })
    .click();
  await expect(page.getByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
});

test('an owner creates a custom role and gives it to a member', async ({ page }) => {
  const business = await createBusiness('Role Paints');
  await signInWithPassword(page, business.ownerPhone);
  await openTeam(page);
  await page
    .getByRole('navigation', { name: 'Team sections' })
    .getByRole('link', { name: 'Roles and permissions' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Roles and permissions', level: 1 }),
  ).toBeVisible();
  await expectUsable(page);

  await page.getByRole('link', { name: 'Owner' }).click();
  await expect(
    page.getByText(
      'System roles come with the app and cannot be changed. Create a custom role instead.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'See the audit log' })).toBeDisabled();
  await page.getByRole('link', { name: 'Back to roles' }).click();

  await page.getByRole('link', { name: '+ Role' }).click();
  await page.getByRole('textbox', { name: 'Role name' }).fill('Godown keeper');
  const stock = page.getByRole('group', { name: 'Stock' });
  await stock.getByRole('checkbox', { name: 'See stock, transfers and stock counts' }).check();
  await stock
    .getByRole('checkbox', {
      name: 'Adjust stock, request and send transfers, and run stock counts',
    })
    .check();
  await page.getByRole('checkbox', { name: 'See stores' }).check();
  await expectUsable(page);
  await page.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByText('Role Godown keeper created')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Godown keeper', level: 1 })).toBeVisible();

  await page.getByRole('checkbox', { name: 'See products and prices' }).check();
  await page.getByRole('button', { name: 'Save role' }).click();
  await expect(page.getByText('Role saved')).toBeVisible();

  const roles = await call<
    { key: string; name: string; isSystem: boolean; permissions: string[] }[]
  >('GET', '/roles', { token: business.token });
  expect(roles.find((role) => role.name === 'Godown keeper')).toMatchObject({
    isSystem: false,
    permissions: ['catalog:read', 'inventory:manage', 'inventory:read', 'stores:read'],
  });

  await openTeam(page);
  await page.getByRole('link', { name: '+ Team member' }).click();
  await page.getByRole('textbox', { name: 'Full name' }).fill('Mahesh Godown');
  await page
    .getByRole('textbox', { name: 'Email' })
    .fill(`mahesh${String(Date.now())}@example.com`);
  await page.getByRole('combobox', { name: 'Role' }).selectOption('Godown keeper');
  await page.getByRole('checkbox', { name: 'PUN · Pune' }).check();
  await page.getByRole('button', { name: 'Add member' }).click();
  await expect(page.getByRole('heading', { name: 'Mahesh Godown', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Contact' })).toContainText('Godown keeper');
});

test('an admin is told when they may not change an owner', async ({ page }) => {
  const business = await createBusiness('Guard Paints');
  const phone = uniquePhone();
  await call('POST', '/members', {
    token: business.token,
    body: {
      fullName: 'Kiran Admin',
      phone,
      password: PASSWORD,
      roleId: await roleId(business, 'org_admin'),
      allStores: true,
    },
  });
  await signInWithPassword(page, phone);
  await openTeam(page);
  await page.getByRole('link', { name: 'Anil Owner' }).click();
  const access = page.getByRole('region', { name: 'Role and stores' });
  // An admin cannot make anyone an owner, so the owner role is not offered...
  await expect(access.getByRole('combobox', { name: 'Role' })).toHaveValue(/.+/);
  await access.getByRole('combobox', { name: 'Role' }).selectOption('Store Employee');
  await access
    .getByRole('checkbox', { name: 'All stores, including stores added later' })
    .uncheck();
  await access.getByRole('checkbox', { name: 'HYD · Hyderabad' }).check();
  await access.getByRole('button', { name: 'Save changes' }).click();
  // ...and the API refuses changing an owner, which the page shows.
  await expect(access.getByRole('alert')).toHaveText(
    'This member has access you are not allowed to manage',
  );
  // No reset for admins: only owners may reset two-factor sign-in.
  await expect(page.getByRole('button', { name: 'Reset two-factor' })).toHaveCount(0);
  await expectUsable(page);
});

test('the team fits a phone screen @phone', async ({ page }) => {
  const business = await createBusiness('Pocket Team Paints');
  await signInWithPassword(page, business.ownerPhone);
  await page.goto('/team');
  await expect(page.getByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Anil Owner' })).toBeVisible();
  await expectUsable(page);
  await page.getByRole('link', { name: '+ Team member' }).click();
  await expect(page.getByRole('heading', { name: 'Add a team member', level: 1 })).toBeVisible();
  await expectUsable(page);
  await page.goto('/team/roles/new');
  await expect(page.getByRole('heading', { name: 'New role', level: 1 })).toBeVisible();
  await expectUsable(page);
});
