import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { call, createBusiness, signInWithPassword, uniquePhone, type Business } from './support.js';

// Leads, opportunities and projects: from a walk-in's enquiry to a site with its people.

/** Adds a lead through the API, as if captured earlier. */
function addLead(
  business: Business,
  title: string,
  name: string,
  estimatedValuePaise?: number,
): Promise<{ id: string; number: string }> {
  return call('POST', '/leads', {
    token: business.token,
    body: {
      storeId: business.stores[0]?.id,
      contact: { displayName: name, phone: uniquePhone() },
      title,
      source: 'walk_in',
      ...(estimatedValuePaise === undefined ? {} : { estimatedValuePaise }),
    },
  });
}

async function openMenuAction(page: Page, menu: string, action: string) {
  await page.getByRole('button', { name: menu }).click();
  await page.getByRole('dialog', { name: menu }).getByRole('button', { name: action }).click();
}

test('an owner takes a walk-in from lead to opportunity to project', async ({ page }) => {
  // A whole sale in one test: give it more than the default 30 s.
  test.setTimeout(120_000);
  const business = await createBusiness('Pipeline Paints');
  await call('POST', '/parties', {
    token: business.token,
    body: { displayName: 'Ramu Contractor', phone: uniquePhone(), roles: ['contractor'] },
  });
  await addLead(business, 'Shop front repaint', 'Kiran Stores', 25_000_000);
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  // A new contact walks in.
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('link', { name: 'Leads' })
    .click();
  await expect(page.getByRole('heading', { name: 'Leads', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: '+ Lead' }).click();
  await page.getByRole('button', { name: 'New contact' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Meera Reddy');
  await page.getByRole('textbox', { name: 'Mobile number', exact: true }).fill(uniquePhone());
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Villa interiors');
  await page.getByRole('combobox', { name: 'Store' }).selectOption({ label: 'HYD · Hyderabad' });
  await page.getByRole('combobox', { name: 'Source' }).selectOption('referral');
  await page.getByRole('textbox', { name: 'Estimated value (₹)' }).fill('8,50,000');
  await expectUsable(page);
  await page.getByRole('button', { name: 'Add lead' }).click();
  await expect(page.getByText('Lead added')).toBeVisible();
  const heading = page.getByRole('heading', { name: /^LD-\d+ · Villa interiors$/, level: 1 });
  await expect(heading).toBeVisible();
  const leadNumber = String(await heading.textContent()).split(' · ')[0] ?? '';

  // The call is logged, and the lead qualified.
  const activities = page.getByRole('region', { name: 'Activities' });
  await activities.getByRole('button', { name: 'Log activity' }).click();
  const log = page.getByRole('dialog', { name: 'Log a call, visit or note' });
  await log.getByRole('textbox', { name: 'What about' }).fill('Discussed shades');
  await log.getByRole('textbox', { name: 'Outcome' }).fill('Visit the site on Monday');
  await expectUsable(page);
  await log.getByRole('button', { name: 'Log activity' }).click();
  await expect(activities).toContainText('Discussed shades');
  await openMenuAction(page, `Move ${leadNumber}`, 'Move to Qualified');
  await expect(page.getByText(`${leadNumber} moved to Qualified`)).toBeVisible();

  // The board shows both leads with their values in lakh.
  await page.goto('/leads/board');
  await expect(page.getByRole('region', { name: 'Qualified' })).toContainText('1 · ₹8.5 L');
  await expect(page.getByRole('region', { name: 'New' })).toContainText('1 · ₹2.5 L');
  await expect(page.getByRole('region', { name: 'New' })).toContainText('Shop front repaint');
  await expectUsable(page);

  // Converted into an opportunity, which is won.
  await page.getByRole('link', { name: `${leadNumber} · Villa interiors` }).click();
  await openMenuAction(page, `Move ${leadNumber}`, 'Convert to opportunity');
  const convert = page.getByRole('dialog', { name: `Convert ${leadNumber} to an opportunity` });
  await expect(convert.getByRole('textbox', { name: 'Expected value (₹)' })).toHaveValue(
    '850000.00',
  );
  await convert.getByRole('textbox', { name: 'Chance of winning (%)' }).fill('60');
  await convert.getByRole('button', { name: 'Convert' }).click();
  const opportunityHeading = page.getByRole('heading', { name: /^OP-\d+ · Villa interiors$/ });
  await expect(opportunityHeading).toBeVisible();
  const opportunityNumber = String(await opportunityHeading.textContent()).split(' · ')[0] ?? '';
  await expect(page.getByRole('region', { name: 'Details' })).toContainText('Chance60%');
  await openMenuAction(page, `Move ${opportunityNumber}`, 'Move to Proposal');
  await expect(page.getByText(`${opportunityNumber} moved`)).toBeVisible();
  await expectUsable(page);
  await openMenuAction(page, `Move ${opportunityNumber}`, 'Mark won');
  await expect(page.getByText(`${opportunityNumber} won`)).toBeVisible();

  // The job starts as a project; the contractor joins it.
  await page.getByRole('button', { name: 'Start project' }).click();
  const projectHeading = page.getByRole('heading', { name: /^PJ-\d+ · Villa interiors$/ });
  await expect(projectHeading).toBeVisible();
  const projectNumber = String(await projectHeading.textContent()).split(' · ')[0] ?? '';
  await expect(page.getByRole('region', { name: 'Job' })).toContainText(opportunityNumber);
  const people = page.getByRole('region', { name: 'People' });
  await expect(people).toContainText('Meera Reddy');
  await people.getByRole('button', { name: 'Add person' }).click();
  const add = page.getByRole('dialog', { name: 'Add a person to the project' });
  await add.getByRole('combobox', { name: 'Role' }).selectOption('contractor');
  await add.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }).fill('Ramu');
  await expectUsable(page);
  await add.getByRole('button', { name: 'Choose Ramu Contractor' }).click();
  await expect(page.getByText('Contractor added')).toBeVisible();
  await expect(people).toContainText('Ramu Contractor');
  await openMenuAction(page, `Change the stage of ${projectNumber}`, 'Move to Survey');
  await expect(page.getByText(`${projectNumber} moved to Survey`)).toBeVisible();
  await expectUsable(page);
  await people.getByRole('button', { name: 'Remove Ramu Contractor as Contractor' }).click();
  await expect(page.getByText('Ramu Contractor removed')).toBeVisible();
  await expect(people).not.toContainText('Ramu Contractor');

  // The customer 360 links to the real screens.
  await people.getByRole('link', { name: 'Meera Reddy' }).click();
  await page.getByRole('region', { name: 'Leads' }).getByRole('link').first().click();
  await expect(heading).toBeVisible();
  await expect(page.getByText('This lead became an opportunity.')).toBeVisible();
});

test('the CRM screens work on a phone @phone', async ({ page }) => {
  test.setTimeout(90_000);
  const business = await createBusiness('Phone Pipeline Paints');
  const lead = await addLead(
    business,
    'Two-bedroom flat, interiors and grills',
    'Venkata Subramanian Iyer',
    1_25_00_00_000,
  );
  await addLead(business, 'Compound wall', 'Ravi');
  const project = await call<{ id: string }>('POST', '/projects', {
    token: business.token,
    body: {
      storeId: business.stores[0]?.id,
      customerPartyId: (
        await call<{ party: { id: string } }>('GET', `/leads/${lead.id}`, { token: business.token })
      ).party.id,
      name: 'Gachibowli apartment block',
      addressLine: 'Plot 44, Financial District',
      city: 'Hyderabad',
      expectedOrderValuePaise: 3_50_00_000,
    },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.goto('/leads');
  await expect(page.getByRole('table', { name: 'Leads' })).toContainText('Compound wall');
  await expectUsable(page);
  await page.goto('/leads/board');
  await expect(page.getByRole('region', { name: 'New' })).toContainText('2 · ₹1.25 Cr');
  await expectUsable(page);
  await page.getByRole('button', { name: `Move ${lead.number}` }).click();
  await expect(page.getByRole('dialog', { name: `Move ${lead.number}` })).toBeVisible();
  await expectUsable(page);
  await page.keyboard.press('Escape');
  await page.goto(`/leads/${lead.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(lead.number);
  await expectUsable(page);
  await page.goto('/leads/new');
  await page.getByRole('button', { name: 'New contact' }).click();
  await expectUsable(page);
  await page.goto('/opportunities');
  await expect(page.getByText('No opportunities yet')).toBeVisible();
  await expectUsable(page);
  await page.goto('/projects');
  await expect(page.getByRole('table', { name: 'Projects' })).toContainText('Gachibowli');
  await expectUsable(page);
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole('region', { name: 'Site' })).toContainText(
    'Plot 44, Financial District',
  );
  await expectUsable(page);
  await page.getByRole('button', { name: 'Schedule follow-up' }).click();
  await expect(page.getByRole('dialog', { name: 'Schedule a follow-up' })).toBeVisible();
  await expectUsable(page);
});
