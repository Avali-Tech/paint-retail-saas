import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import {
  PASSWORD,
  addMember,
  call,
  createBusiness,
  signInWithPassword,
  uniquePhone,
  type Business,
} from './support.js';

/** A calendar day in India, `days` from today (YYYY-MM-DD). */
function indiaDay(days: number): string {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const moment = new Date(`${today}T00:00:00Z`);
  moment.setUTCDate(moment.getUTCDate() + days);
  return moment.toISOString().slice(0, 10);
}
const at = (days: number, time: string) => `${indiaDay(days)}T${time}:00+05:30`;

/** A customer with a follow-up overdue, one due today, one coming up and a logged visit. */
async function customerWithFollowUps(business: Business): Promise<string> {
  const { token } = business;
  const party = await call<{ id: string }>('POST', '/parties', {
    token,
    body: { displayName: 'Apex Builders', roles: ['customer'] },
  });
  const activity = (body: Record<string, unknown>) =>
    call('POST', '/activities', {
      token,
      body: { recordType: 'party', recordId: party.id, ...body },
    });
  await activity({ type: 'call', subject: 'Call about the quote', dueAt: at(-1, '11:00') });
  await activity({ type: 'whatsapp', subject: 'Send the shade card', dueAt: at(0, '23:30') });
  await activity({ type: 'visit', subject: 'Site visit', dueAt: at(2, '10:00') });
  await activity({ type: 'visit', subject: 'Met at the counter', outcome: 'Wants Apex Ultima' });
  return party.id;
}

const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test('the owner works through follow-ups from the dashboard and reads a timeline', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const business = await createBusiness('Follow-up Paints');
  const partyId = await customerWithFollowUps(business);
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  // An owner's tile counts the team's follow-ups, and opens them.
  await expect(page.getByRole('heading', { name: 'Team follow-ups' })).toBeVisible();
  await page.getByRole('link', { name: 'Open the team’s follow-ups' }).click();
  await expect(page.getByRole('heading', { name: 'Team follow-ups', level: 1 })).toBeVisible();
  await expect(region(page, 'Overdue')).toContainText('Assigned to Anil Owner');
  await page.getByRole('combobox', { name: 'Assigned to' }).selectOption({ label: 'Me' });
  await expect(page.getByRole('heading', { name: 'My follow-ups', level: 1 })).toBeVisible();

  await expect(region(page, 'Overdue')).toContainText('Call about the quote');
  await expect(region(page, 'Due today')).toContainText('Send the shade card');
  await expect(region(page, 'Upcoming')).toContainText('Site visit');
  await expectUsable(page);

  // Done, with what happened and the next step tomorrow at 10:30.
  await page.getByRole('button', { name: 'Mark “Call about the quote” done' }).click();
  const done = page.getByRole('dialog', { name: 'Done: Call about the quote' });
  await done.getByRole('textbox', { name: 'What happened' }).fill('Ordered 40 L Apex');
  await done.getByRole('checkbox', { name: 'Schedule the next step' }).check();
  await done.getByLabel(/^Next step on/).fill(`${indiaDay(1)}T10:30`);
  await done.getByRole('textbox', { name: 'Next step', exact: true }).fill('Confirm the delivery');
  await expectUsable(page);
  await done.getByRole('button', { name: 'Mark done' }).click();
  await expect(page.getByText(/^Follow-up done; next step on/)).toBeVisible();
  await expect(region(page, 'Overdue')).toContainText('Nothing overdue');
  await expect(region(page, 'Upcoming')).toContainText('Confirm the delivery');

  await page.getByRole('button', { name: 'Reschedule “Site visit”' }).click();
  const reschedule = page.getByRole('dialog', { name: 'Reschedule: Site visit' });
  await expect(reschedule.getByLabel(/^New date and time/)).toHaveValue(`${indiaDay(2)}T10:00`);
  await reschedule.getByLabel(/^New date and time/).fill(`${indiaDay(3)}T12:00`);
  await reschedule.getByRole('button', { name: 'Reschedule' }).click();
  await expect(page.getByText(/^Moved to .*12:00 pm$/)).toBeVisible();

  // The customer's timeline: everything logged, filtered by type.
  await region(page, 'Upcoming')
    .getByRole('link', { name: 'Timeline of Apex Builders' })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/activities\\?recordType=party&recordId=${partyId}$`));
  const timeline = region(page, 'Apex Builders');
  await expect(timeline).toContainText('Outcome: Ordered 40 L Apex');
  await expect(timeline).toContainText('Met at the counter');
  await page.getByRole('combobox', { name: 'Type' }).selectOption('visit');
  await expect(timeline.getByRole('listitem')).toHaveCount(2);
  await page.getByLabel(/^From/).fill(indiaDay(1));
  await expect(timeline.getByRole('listitem')).toHaveCount(1);
  await expect(timeline).toContainText('Site visit');
  await expectUsable(page);

  // Every record's activities, filtered by the API.
  await page.getByRole('link', { name: 'All activities' }).click();
  await expect(page).toHaveURL(/\/activities$/);
  await expect(page.getByRole('link', { name: 'Apex Builders' }).first()).toBeVisible();
  await page.getByRole('combobox', { name: 'Record' }).selectOption({ label: 'Customer or party' });
  await page.getByRole('combobox', { name: 'Type' }).selectOption('whatsapp');
  await expect(page.getByRole('listitem').filter({ hasText: 'Send the shade card' })).toBeVisible();
  await expect(page.getByText('Met at the counter')).toBeHidden();
  await expectUsable(page);
});

test('a manager sees the team’s follow-ups; staff see their own, on the dashboard too', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const business = await createBusiness('Team Follow-up Paints');
  const partyId = await customerWithFollowUps(business);
  const staffPhone = uniquePhone();
  await addMember(business, 'sales_executive', {
    fullName: 'Sunita Sales',
    phone: staffPhone,
    password: PASSWORD,
  });
  const members = await call<{ id: string; user: { fullName: string } }[]>('GET', '/members', {
    token: business.token,
  });
  const sunita = members.find((member) => member.user.fullName === 'Sunita Sales');
  await call('POST', '/activities', {
    token: business.token,
    body: {
      recordType: 'party',
      recordId: partyId,
      type: 'call',
      subject: 'Call for Sunita',
      dueAt: at(0, '23:45'),
      assignedMemberId: sunita?.id,
    },
  });

  await signInWithPassword(page, staffPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  // Without the team list the tile is the member's own, and so is the page it opens.
  await expect(page.getByRole('heading', { name: 'My follow-ups' })).toBeVisible();
  await page.getByRole('link', { name: 'Open my follow-ups' }).click();
  await expect(region(page, 'Due today')).toContainText('Call for Sunita');
  await expect(region(page, 'Due today')).not.toContainText('Send the shade card');
  await expect(page.getByRole('combobox', { name: 'Assigned to' })).toBeHidden();
  await expectUsable(page);
});

test('follow-ups and the timeline fit a phone @phone', async ({ page }) => {
  const business = await createBusiness('Phone Follow-up Paints');
  const partyId = await customerWithFollowUps(business);
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/follow-ups');
  await expect(region(page, 'Overdue')).toContainText('Call about the quote');
  await expect(region(page, 'Upcoming')).toContainText('Site visit');
  await expectUsable(page);
  await page.getByRole('button', { name: 'Mark “Call about the quote” done' }).click();
  await page.getByRole('checkbox', { name: 'Schedule the next step' }).check();
  await expectUsable(page);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.goto(`/activities?recordType=party&recordId=${partyId}`);
  await expect(region(page, 'Apex Builders')).toContainText('Met at the counter');
  await expectUsable(page);
});
