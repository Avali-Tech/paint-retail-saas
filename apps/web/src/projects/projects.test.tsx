import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Project, ProjectSummary } from '../api/projects.js';
import {
  crmRoutes,
  party,
  project,
  sent,
  type RecordOptions,
} from '../leads/test-support/fixtures.js';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { page } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { siteAddress } from './ProjectDetailPage.js';
import { toDetails } from './ProjectFormPage.js';

const location = () => screen.getByTestId('location').textContent;
const READER = profile(['stores:read', 'projects:read']);

const summary = (overrides: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: 'project-1',
  number: 'PJ-000001',
  name: 'Jubilee Hills villa',
  store: { id: 'store-hyd', code: 'HYD', name: 'Hyderabad' },
  customer: { id: 'party-1', name: 'Apex Builders', phone: null },
  city: 'Hyderabad',
  stage: 'survey',
  expectedOrderValuePaise: 45_000_000,
  assignedTo: { memberId: 'member-1', name: 'Anil Kumar' },
  updatedAt: '2026-10-02T05:00:00.000Z',
  ...overrides,
});

describe('siteAddress', () => {
  it('joins what is known of the site', () => {
    const site = project().site;
    expect(siteAddress(site)).toBe('Plot 12, Road 36, Hyderabad, Telangana 500033');
    expect(siteAddress({ ...site, addressLine: null, state: null })).toBe('Hyderabad, 500033');
    expect(
      siteAddress({ ...site, addressLine: null, city: null, state: null, pincode: null }),
    ).toBeNull();
  });
});

describe('ProjectsPage', () => {
  it('lists projects and filters them', async () => {
    const { user, requests } = renderApp({
      path: '/projects',
      routes: {
        ...crmRoutes(),
        'GET /projects': () =>
          json(
            page(
              [
                summary(),
                summary({
                  id: 'project-2',
                  number: 'PJ-000002',
                  city: null,
                  expectedOrderValuePaise: null,
                  stage: 'completed',
                }),
              ],
              70,
            ),
          ),
      },
    });
    const table = await screen.findByRole('table', { name: 'Projects' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      'ProjectCustomerCityStageOrder valueAssigned toUpdated',
      'PJ-000001Jubilee Hills villaApex BuildersHYDHyderabadSurvey₹4,50,000.00Anil Kumar2 Oct 2026',
      'PJ-000002Jubilee Hills villaApex BuildersHYD—Completed—Anil Kumar2 Oct 2026',
    ]);
    expect(screen.getByRole('link', { name: '+ Project' })).toHaveAttribute(
      'href',
      '/projects/new',
    );
    await user.type(screen.getByRole('searchbox', { name: /Search/ }), 'villa');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Stage' }), 'survey');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'store-hyd');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assigned to' }), 'member-2');
    await waitFor(() => {
      expect(
        requests
          .filter((request) => request.path === '/projects')
          .at(-1)
          ?.query.toString(),
      ).toBe('q=villa&stage=survey&storeId=store-hyd&assignedTo=member-2&limit=50&offset=0');
    });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(location()).toContain('offset=50');
    });
  });

  it('says when there are none, and when none match', async () => {
    const { user } = renderApp({
      path: '/projects',
      routes: { ...crmRoutes(READER), 'GET /projects': () => json(page([])) },
    });
    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '+ Project' })).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Stage' }), 'order');
    expect(await screen.findByText('No projects match these filters')).toBeInTheDocument();
  });
});

describe('toDetails', () => {
  it('sends numbers and null for what was emptied', () => {
    expect(
      toDetails({
        name: ' Villa ',
        storeId: '',
        assignee: '',
        addressLine: '',
        city: 'Pune',
        state: '',
        pincode: '',
        startDate: '',
        expectedCompletionDate: '',
        area: '1200.5',
        litres: '',
        value: '',
        notes: '',
      }),
    ).toEqual({
      name: 'Villa',
      addressLine: null,
      city: 'Pune',
      state: null,
      pincode: null,
      startDate: null,
      expectedCompletionDate: null,
      estimatedAreaSqFt: 1200.5,
      estimatedPaintLitres: null,
      expectedOrderValuePaise: null,
      notes: null,
    });
  });
});

describe('NewProjectPage', () => {
  it('adds a project for a customer, with its site and job', async () => {
    const { user, requests } = renderApp({
      path: '/projects/new',
      routes: {
        ...crmRoutes(),
        'GET /parties': () => json(page([party()])),
        'POST /projects': () => json(project({ id: 'project-7' })),
        'GET /projects/:id': () => json(project({ id: 'project-7' })),
      },
    });
    await user.type(await screen.findByRole('searchbox', { name: /Search by name/ }), 'meera');
    await user.click(await screen.findByRole('button', { name: 'Choose Meera Reddy' }));
    expect(screen.getByRole('heading', { name: 'Customer: Meera Reddy' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    expect(await screen.findByText('Enter a name')).toBeVisible();
    expect(screen.getByText('Choose the store')).toBeVisible();

    await user.type(screen.getByRole('textbox', { name: /Project name/ }), 'Banjara Hills flat');
    await user.selectOptions(screen.getByRole('combobox', { name: /Store/ }), 'store-hyd');
    await user.selectOptions(screen.getByRole('combobox', { name: /Assigned to/ }), 'member-2');
    await user.type(screen.getByRole('textbox', { name: 'PIN code' }), '123');
    await user.type(screen.getByRole('textbox', { name: /Area/ }), '0');
    await user.type(screen.getByRole('textbox', { name: /Paint needed/ }), '1.2345');
    await user.type(screen.getByRole('textbox', { name: /Expected order value/ }), 'abc');
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-11-10' } });
    fireEvent.change(screen.getByLabelText('Expected completion'), {
      target: { value: '2026-11-01' },
    });
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    expect(await screen.findByText('Enter a 6-digit PIN code')).toBeVisible();
    expect(screen.getByText('Enter an area above 0, with at most 2 decimals')).toBeVisible();
    expect(screen.getByText('Enter litres above 0, with at most 3 decimals')).toBeVisible();
    expect(screen.getByText('Enter an amount in rupees, such as 85000')).toBeVisible();
    expect(screen.getByText('The expected completion cannot be before the start')).toBeVisible();

    await user.clear(screen.getByRole('textbox', { name: 'PIN code' }));
    await user.type(screen.getByRole('textbox', { name: 'PIN code' }), '500034');
    await user.clear(screen.getByRole('textbox', { name: /Area/ }));
    await user.type(screen.getByRole('textbox', { name: /Area/ }), '1800');
    await user.clear(screen.getByRole('textbox', { name: /Paint needed/ }));
    await user.type(screen.getByRole('textbox', { name: /Paint needed/ }), '140.5');
    await user.clear(screen.getByRole('textbox', { name: /Expected order value/ }));
    await user.type(screen.getByRole('textbox', { name: /Expected order value/ }), '2,40,000');
    fireEvent.change(screen.getByLabelText('Expected completion'), {
      target: { value: '2026-12-20' },
    });
    await user.type(screen.getByRole('textbox', { name: 'Street and area' }), 'Road 12');
    await user.type(screen.getByRole('textbox', { name: 'City' }), 'Hyderabad');
    await user.click(screen.getByRole('button', { name: 'Add project' }));

    expect(await screen.findByText('Project added')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/projects')).toEqual({
      name: 'Banjara Hills flat',
      addressLine: 'Road 12',
      city: 'Hyderabad',
      pincode: '500034',
      startDate: '2026-11-10',
      expectedCompletionDate: '2026-12-20',
      estimatedAreaSqFt: 1800,
      estimatedPaintLitres: 140.5,
      expectedOrderValuePaise: 24_000_000,
      storeId: 'store-hyd',
      customerPartyId: 'party-9',
      assignedMemberId: 'member-2',
    });
    await waitFor(() => {
      expect(location()).toBe('/projects/project-7');
    });
  });

  it('goes back to choosing the customer, and shows the API’s refusal', async () => {
    const { user } = renderApp({
      path: '/projects/new',
      routes: {
        ...crmRoutes(),
        'GET /parties': () => json(page([party({ phone: null })])),
        'POST /projects': () => json({ statusCode: 404, message: 'Store not found' }, 404),
      },
    });
    await user.type(await screen.findByRole('searchbox', { name: /Search by name/ }), 'meera');
    await user.click(await screen.findByRole('button', { name: 'Choose Meera Reddy' }));
    expect(screen.getByText('No mobile number on file')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /Project name/ }), 'Flat');
    await user.selectOptions(screen.getByRole('combobox', { name: /Store/ }), 'store-pun');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    expect(await screen.findByText('Store not found')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose someone else' }));
    expect(screen.getByRole('searchbox', { name: /Search by name/ })).toBeInTheDocument();
  });
});

describe('EditProjectPage', () => {
  it('edits the site and job, clearing what was emptied', async () => {
    const { user, requests } = renderApp({
      path: '/projects/project-1/edit',
      routes: {
        ...crmRoutes(),
        'GET /projects/:id': () => json(project()),
        'PATCH /projects/:id': () => json(project()),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Edit PJ-000001', level: 1 })).toBeVisible();
    expect(screen.getByRole('textbox', { name: /Area/ })).toHaveValue('12500');
    expect(screen.queryByRole('combobox', { name: /Store/ })).toBeNull();
    await user.clear(screen.getByRole('textbox', { name: 'Notes' }));
    await user.clear(screen.getByRole('textbox', { name: /Paint needed/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(sent(requests, 'PATCH', '/projects/project-1')).toEqual({
      name: 'Jubilee Hills villa',
      addressLine: 'Plot 12, Road 36',
      city: 'Hyderabad',
      state: 'Telangana',
      pincode: '500033',
      startDate: '2026-10-10',
      expectedCompletionDate: '2026-12-10',
      estimatedAreaSqFt: 12_500,
      estimatedPaintLitres: null,
      expectedOrderValuePaise: 45_000_000,
      notes: null,
    });
  });

  it('starts empty for a project without details', async () => {
    renderApp({
      path: '/projects/project-1/edit',
      routes: {
        ...crmRoutes(),
        'GET /projects/:id': () =>
          json(
            project({
              site: {
                addressLine: null,
                city: null,
                state: null,
                pincode: null,
                latitude: null,
                longitude: null,
              },
              startDate: null,
              expectedCompletionDate: null,
              estimatedAreaSqFt: null,
              estimatedPaintLitres: null,
              expectedOrderValuePaise: null,
              notes: null,
            }),
          ),
      },
    });
    expect(await screen.findByRole('textbox', { name: /Area/ })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'City' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: /Expected order value/ })).toHaveValue('');
  });
});

function renderProject(shown: Project, { member = OWNER, routes = {} }: RecordOptions = {}) {
  return renderApp({
    path: `/projects/${shown.id}`,
    routes: {
      ...crmRoutes(member),
      'GET /projects/:id': () => json(shown),
      'GET /parties': () => json(page([party()])),
      ...routes,
    },
  });
}

describe('ProjectDetailPage', () => {
  it('shows the site, job, people and linked opportunity', async () => {
    renderProject(project());
    expect(
      await screen.findByRole('heading', { name: 'PJ-000001 · Jubilee Hills villa', level: 1 }),
    ).toBeVisible();
    const site = screen.getByRole('region', { name: 'Site' });
    expect(site).toHaveTextContent('AddressPlot 12, Road 36, Hyderabad, Telangana 500033');
    expect(within(site).getByRole('link', { name: 'Open in maps' })).toHaveAttribute(
      'href',
      'https://www.google.com/maps?q=17.43,78.41',
    );
    const job = screen.getByRole('region', { name: 'Job' });
    expect(job).toHaveTextContent('Area (sq ft)12,500');
    expect(job).toHaveTextContent('Paint needed (litres)900');
    expect(job).toHaveTextContent('Expected order value (₹)₹4,50,000.00');
    expect(job).toHaveTextContent('Start date10 Oct 2026');
    expect(job).toHaveTextContent('NotesGate code 4411');
    expect(within(job).getByRole('link', { name: 'OP-000001' })).toHaveAttribute(
      'href',
      '/opportunities/opp-1',
    );
    const people = within(screen.getByRole('region', { name: 'People' })).getAllByRole('listitem');
    expect(people.map((item) => item.textContent)).toEqual([
      'Apex Builders+919876543210Owner',
      'Ritu Architects+919811111111ArchitectRemove',
      'Raju PainterPainterRemove',
    ]);
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/projects/project-1/edit',
    );
    expect(await screen.findByRole('region', { name: 'Documents' })).toBeInTheDocument();
  });

  it('adds and removes people with their roles', async () => {
    const { user, requests } = renderProject(project(), {
      routes: { 'PUT /projects/:id/parties': () => json(project()) },
    });
    await user.click(await screen.findByRole('button', { name: 'Remove Raju Painter as Painter' }));
    expect(await screen.findByText('Raju Painter removed')).toBeInTheDocument();
    expect(sent(requests, 'PUT', '/projects/project-1/parties')).toEqual({
      parties: [{ partyId: 'party-2', role: 'architect' }],
    });

    await user.click(screen.getByRole('button', { name: 'Add person' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a person to the project' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Role' }), 'painter');
    await user.type(within(dialog).getByRole('searchbox', { name: /Search by name/ }), 'meera');
    await user.click(await within(dialog).findByRole('button', { name: 'Choose Meera Reddy' }));
    expect(await screen.findByText('Painter added')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Add a person to the project' })).toBeNull();
    expect(requests.filter((request) => request.method === 'PUT').at(-1)?.body).toEqual({
      parties: [
        { partyId: 'party-2', role: 'architect' },
        { partyId: 'party-3', role: 'painter' },
        { partyId: 'party-9', role: 'painter' },
      ],
    });
  });

  it('keeps the dialog open when a person cannot be added, and refuses duplicates', async () => {
    const { user } = renderProject(project(), {
      routes: {
        'GET /parties': () =>
          json(page([party({ id: 'party-2', displayName: 'Ritu Architects' })])),
        'PUT /projects/:id/parties': () =>
          json({ statusCode: 409, message: 'This project is completed' }, 409),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Add person' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a person to the project' });
    await user.type(within(dialog).getByRole('searchbox', { name: /Search by name/ }), 'ritu');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Role' }), 'architect');
    await user.click(await within(dialog).findByRole('button', { name: 'Choose Ritu Architects' }));
    expect(await screen.findByText('They already have this role here')).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Role' }), 'dealer');
    await user.click(within(dialog).getByRole('button', { name: 'Choose Ritu Architects' }));
    expect(await screen.findByText('This project is completed')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Add a person to the project' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Add a person to the project' })).toBeNull();
  });

  it('moves the project between stages and cancels it', async () => {
    const { user, requests } = renderProject(project(), {
      routes: {
        'POST /projects/:id/stage': (request) =>
          (request.body as { stage: string }).stage === 'order'
            ? json({ statusCode: 409, message: 'This project is cancelled' }, 409)
            : json(project({ stage: 'quotation' })),
        'POST /projects/:id/cancel': () => json(project({ stage: 'cancelled' })),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Change the stage of PJ-000001' }));
    const menu = screen.getByRole('dialog', { name: 'Change the stage of PJ-000001' });
    expect(
      within(menu)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([
      'Move to Identified',
      'Move to Specification',
      'Move to Quotation',
      'Move to Negotiation',
      'Move to Order',
      'Move to Execution',
      'Move to Completed',
      'Cancel project',
    ]);
    await user.click(within(menu).getByRole('button', { name: 'Move to Quotation' }));
    expect(await screen.findByText('PJ-000001 moved to Quotation')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/projects/project-1/stage')).toEqual({ stage: 'quotation' });
    await user.click(screen.getByRole('button', { name: 'Change the stage of PJ-000001' }));
    await user.click(screen.getByRole('button', { name: 'Move to Order' }));
    expect(await screen.findByText('This project is cancelled')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Change the stage of PJ-000001' }));
    await user.click(screen.getByRole('button', { name: 'Cancel project' }));
    const dialog = screen.getByRole('dialog', { name: 'Why is PJ-000001 cancelled?' });
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Owner postponed');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel project' }));
    expect(await screen.findByText('PJ-000001 cancelled')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/projects/project-1/cancel')).toEqual({
      reason: 'Owner postponed',
    });
  });

  it('reassigns the project', async () => {
    const { user, requests } = renderProject(project(), {
      routes: { 'POST /projects/:id/assign': () => json(project()) },
    });
    await user.click(await screen.findByRole('button', { name: 'Reassign' }));
    const dialog = screen.getByRole('dialog', { name: 'Reassign PJ-000001' });
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Assigned to' }),
      'member-2',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Assign' }));
    expect(await screen.findByText('Reassigned')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/projects/project-1/assign')).toEqual({ memberId: 'member-2' });
  });

  it('shows a closed project read-only, without the details it lacks', async () => {
    renderProject(
      project({
        stage: 'cancelled',
        cancelReason: 'Owner postponed',
        closedAt: '2026-10-05T05:00:00.000Z',
        opportunity: null,
        parties: [],
        site: {
          addressLine: null,
          city: null,
          state: null,
          pincode: null,
          latitude: null,
          longitude: null,
        },
        startDate: null,
        expectedCompletionDate: null,
        estimatedAreaSqFt: null,
        estimatedPaintLitres: null,
        expectedOrderValuePaise: null,
        notes: null,
      }),
    );
    expect(await screen.findByText('No site address yet')).toBeInTheDocument();
    const job = screen.getByRole('region', { name: 'Job' });
    expect(job).toHaveTextContent('Why it was cancelledOwner postponed');
    expect(job).toHaveTextContent('Closed5 Oct 2026');
    expect(job).not.toHaveTextContent('Opportunity');
    expect(screen.getByText('No architect, contractor, painter or dealer yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add person' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Change the stage/ })).toBeNull();
    // Notes on a closed project can still be logged.
    expect(screen.getByRole('button', { name: 'Log activity' })).toBeInTheDocument();
  });

  it('shows the project to someone who only reads projects', async () => {
    renderProject(project(), { member: READER });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Log activity' })).toBeNull();
  });
});
