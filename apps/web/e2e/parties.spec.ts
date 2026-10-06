import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { call, createBusiness, signInWithPassword, uniquePhone } from './support.js';

// A valid GSTIN (Telangana) and one with a typo in its check character.
const GSTIN = '36AABCU9603R1ZO';
const GSTIN_TYPO = '36AABCU9603R1ZM';

async function openCustomers(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('link', { name: 'Customers' })
    .click();
  await expect(page.getByRole('heading', { name: 'Customers & parties', level: 1 })).toBeVisible();
}

test('an owner adds a customer with a GSTIN, finds it and edits it', async ({ page }) => {
  // A whole working day in one test: give it more than the default 30 s.
  test.setTimeout(90_000);
  const business = await createBusiness('Party Paints');
  const phone = uniquePhone();
  await signInWithPassword(page, business.ownerPhone);
  await openCustomers(page);
  await expect(page.getByText('No customers yet')).toBeVisible();
  await expectUsable(page);

  await page.getByRole('link', { name: '+ Customer' }).click();
  await expect(page.getByRole('heading', { name: 'New customer', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: 'Type', exact: true }).selectOption('organization');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Apex Builders');
  await page.getByRole('textbox', { name: 'Mobile number', exact: true }).fill(phone);
  const gstin = page.getByRole('textbox', { name: 'GSTIN' });
  await gstin.fill(GSTIN_TYPO);
  await expect(page.getByText('This GSTIN is not valid. Check for typos.')).toBeVisible();
  await gstin.fill(GSTIN.toLowerCase());
  await expect(page.getByText('Valid GSTIN · PAN AABCU9603R')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'PAN' })).toHaveValue('AABCU9603R');
  await page
    .getByRole('combobox', { name: 'Home store' })
    .selectOption({ label: 'HYD · Hyderabad' });
  await page.getByRole('checkbox', { name: 'Contractor' }).check();
  await page.getByRole('combobox', { name: 'Customer type' }).selectOption('builder');
  await expectUsable(page);
  await page.getByRole('button', { name: 'Add customer' }).click();

  await expect(page.getByText('Customer added')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Apex Builders', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Contact' })).toContainText(GSTIN);
  await expectUsable(page);

  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Legal name' }).fill('Apex Builders Private Limited');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Contact' })).toContainText(
    'Apex Builders Private Limited',
  );

  await openCustomers(page);
  await page.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }).fill('AABCU9603R');
  const table = page.getByRole('table', { name: 'Customers' });
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table).toContainText('Apex Builders');
  await page.getByRole('combobox', { name: 'Role' }).selectOption('supplier');
  await expect(page.getByText('No one matches these filters')).toBeVisible();
});

test('adding someone already on file points to the existing record', async ({ page }) => {
  const business = await createBusiness('Duplicate Paints');
  const phone = uniquePhone();
  const existing = await call<{ id: string }>('POST', '/parties', {
    token: business.token,
    body: { displayName: 'Ramesh Painter', phone, roles: ['painter'] },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/parties/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Ramesh P');
  await page.getByRole('textbox', { name: 'Mobile number', exact: true }).fill(phone);
  await page.getByRole('button', { name: 'Add customer' }).click();
  await expect(page.getByText('Someone with this mobile number is already on file.')).toBeVisible();
  await page.getByRole('link', { name: 'Open the existing record' }).click();
  await expect(page).toHaveURL(new RegExp(`/parties/${existing.id}$`));
  await expect(page.getByRole('heading', { name: 'Ramesh Painter', level: 1 })).toBeVisible();
});

test('the customer list and 360 fit a phone without sideways scrolling @phone', async ({
  page,
}) => {
  const business = await createBusiness('Phone Party Paints');
  const party = await call<{ id: string }>('POST', '/parties', {
    token: business.token,
    body: {
      kind: 'organization',
      displayName: 'Sri Lakshmi Contractors and Builders Private Limited',
      phone: uniquePhone(),
      gstin: GSTIN,
      roles: ['customer', 'contractor'],
    },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/parties');
  await expect(page.getByRole('table', { name: 'Customers' })).toContainText('Sri Lakshmi');
  await expectUsable(page);
  await page.goto(`/parties/${party.id}`);
  await expect(page.getByRole('region', { name: 'Credit' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Loyalty points' })).toBeVisible();
  await expectUsable(page);
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'GSTIN' })).toHaveValue(GSTIN);
  await expectUsable(page);
});

test('the customer 360 gathers leads, projects, contracts and activities', async ({ page }) => {
  const business = await createBusiness('Overview Paints');
  const [store] = business.stores;
  const token = business.token;
  const party = await call<{ id: string }>('POST', '/parties', {
    token,
    body: { displayName: 'Lake View Developers', roles: ['customer'], homeStoreId: store?.id },
  });
  const lead = await call<{ number: string }>('POST', '/leads', {
    token,
    body: {
      storeId: store?.id,
      partyId: party.id,
      title: 'Tower A repaint',
      source: 'walk_in',
      estimatedValuePaise: 2_00_000_00,
    },
  });
  const project = await call<{ number: string }>('POST', '/projects', {
    token,
    body: { storeId: store?.id, customerPartyId: party.id, name: 'Lake View Towers' },
  });
  const contract = await call<{ number: string }>('POST', '/contracts', {
    token,
    body: {
      type: 'customer_agreement',
      title: 'Annual rate contract',
      partyId: party.id,
      startDate: '2026-04-01',
      endDate: '2027-03-31',
      valuePaise: 10_00_000_00,
    },
  });
  await call('POST', '/activities', {
    token,
    body: { recordType: 'party', recordId: party.id, type: 'visit', subject: 'Site visit' },
  });
  await call('POST', '/activities', {
    token,
    body: {
      recordType: 'party',
      recordId: party.id,
      type: 'call',
      subject: 'Call about the quote',
      dueAt: '2027-01-15T11:00:00+05:30',
    },
  });

  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto(`/parties/${party.id}`);
  await expect(page.getByRole('heading', { name: 'Lake View Developers', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Contact' })).toContainText(
    `${String(store?.code)} · ${String(store?.name)}`,
  );
  const leads = page.getByRole('region', { name: 'Leads' });
  await expect(leads).toContainText(`${lead.number} · Tower A repaint`);
  await expect(leads).toContainText('1 open');
  const projects = page.getByRole('region', { name: 'Projects' });
  await expect(projects).toContainText(`${project.number} · Lake View Towers`);
  await expect(projects).toContainText('Customer');
  const contracts = page.getByRole('region', { name: 'Contracts' });
  await expect(contracts).toContainText(`${contract.number} · Annual rate contract`);
  await expect(contracts).toContainText('Customer agreement · Draft');
  const activities = page.getByRole('region', { name: 'Activities' });
  await expect(activities).toContainText('Next follow-up: Call about the quote · 15 Jan 2027');
  await expect(activities).toContainText('Site visit');
  await expect(page.getByRole('region', { name: 'Documents' })).toContainText('No documents yet');
  await expectUsable(page);
});

test('a duplicate customer is merged into the one that stays', async ({ page }) => {
  test.setTimeout(90_000);
  const business = await createBusiness('Merge Paints');
  const [store] = business.stores;
  const token = business.token;
  const party = (displayName: string) =>
    call<{ id: string }>('POST', '/parties', {
      token,
      body: { displayName, phone: uniquePhone(), roles: ['customer'], homeStoreId: store?.id },
    });
  const keep = await party('Sri Sai Constructions');
  const duplicate = await party('Sri Sai Constructions (old)');
  for (const title of ['Tower A', 'Tower B']) {
    await call('POST', '/leads', {
      token,
      body: { storeId: store?.id, partyId: duplicate.id, title, source: 'walk_in' },
    });
  }

  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto(`/parties/${duplicate.id}`);
  await page.getByRole('button', { name: 'Merge into…' }).click();
  const dialog = page.getByRole('dialog', { name: /^Merge Sri Sai Constructions \(old\)/ });
  await expect(dialog.getByRole('region', { name: 'What happens' })).toContainText(
    'This cannot be undone.',
  );
  await dialog.getByRole('searchbox').fill('sri sai');
  await dialog.getByRole('button', { name: 'Choose Sri Sai Constructions', exact: true }).click();
  await expect(dialog).toContainText(
    'Keep Sri Sai Constructions; merge Sri Sai Constructions (old) into it',
  );
  await expectUsable(page);
  await dialog.getByRole('button', { name: 'Merge' }).click();

  await expect(page.getByText('Merged into Sri Sai Constructions')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/parties/${keep.id}$`));
  const leads = page.getByRole('region', { name: 'Leads' });
  await expect(leads).toContainText('Tower A');
  await expect(leads).toContainText('Tower B');

  // The old record points to the one that stays.
  await page.goto(`/parties/${duplicate.id}`);
  await expect(page.getByText('This record was merged into another one.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Merge into…' })).toBeHidden();
});

test('the customer 360 opens all of a customer’s leads', async ({ page }) => {
  test.setTimeout(90_000);
  const business = await createBusiness('Many Leads Paints');
  const [store] = business.stores;
  const token = business.token;
  const party = await call<{ id: string }>('POST', '/parties', {
    token,
    body: { displayName: 'Busy Builders', phone: uniquePhone(), roles: ['customer'] },
  });
  const other = await call<{ id: string }>('POST', '/parties', {
    token,
    body: { displayName: 'Someone Else', phone: uniquePhone(), roles: ['customer'] },
  });
  await call('POST', '/leads', {
    token,
    body: { storeId: store?.id, partyId: other.id, title: 'Not theirs', source: 'walk_in' },
  });
  for (let index = 1; index <= 11; index += 1) {
    await call('POST', '/leads', {
      token,
      body: {
        storeId: store?.id,
        partyId: party.id,
        title: `Job ${String(index)}`,
        source: 'walk_in',
      },
    });
  }

  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto(`/parties/${party.id}`);
  const leads = page.getByRole('region', { name: 'Leads' });
  await expect(leads).toContainText('Latest 10 of 11');
  await leads.getByRole('link', { name: 'See all Leads' }).click();
  await expect(page).toHaveURL(new RegExp(`/leads\\?party=${party.id}$`));
  await expect(page.getByText('For Busy Builders only')).toBeVisible();
  const table = page.getByRole('table', { name: 'Leads' });
  await expect(table.getByRole('row')).toHaveCount(12);
  await expect(table).not.toContainText('Not theirs');
  await expectUsable(page);
  await page.getByRole('button', { name: 'Show everyone’s' }).click();
  await expect(table).toContainText('Not theirs');
});
