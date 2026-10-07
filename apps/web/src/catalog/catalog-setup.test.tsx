import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Brand, Category } from '../api/catalog.js';
import { CASHIER, OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { found } from '../test-support/found.js';
import { BRANDS, CATEGORIES } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';

function renderSetup(routes: Record<string, FakeHandler> = {}, member = OWNER) {
  return renderApp({
    path: '/products/setup',
    routes: {
      'GET /auth/me': () => json(member),
      'GET /brands': () => json(BRANDS),
      'GET /categories': () => json(CATEGORIES),
      ...routes,
    },
  });
}

const region = (name: string) => screen.getByRole('region', { name });

describe('CatalogSetupPage', () => {
  it('lists brands and categories, with subcategories under their parent', async () => {
    renderSetup();
    expect(
      await screen.findByRole('heading', { name: 'Brands & categories', level: 1 }),
    ).toBeVisible();
    const brands = await screen.findByRole('region', { name: 'Brands' });
    expect(within(brands).getByText('Old Brand')).toBeInTheDocument();
    expect(within(brands).getByText('Inactive')).toBeInTheDocument();
    const categories = region('Categories');
    expect(within(categories).getByText('Emulsions › Interior emulsions')).toBeInTheDocument();
    // Only top-level categories can hold subcategories.
    const parent = within(categories).getByRole('combobox', { name: 'Inside' });
    expect(
      within(parent)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Top level', 'Emulsions']);
  });

  it('adds, renames, deactivates and reactivates brands', async () => {
    const brands: Brand[] = [...BRANDS];
    const bodies: unknown[] = [];
    const { user } = renderSetup({
      'GET /brands': () => json(brands),
      'POST /brands': (request) => {
        bodies.push(request.body);
        brands.push({ id: 'brand-new', name: 'Berger', isActive: true });
        return json(brands.at(-1), 201);
      },
      'PATCH /brands/:id': (request) => {
        bodies.push(request.body);
        return json(brands[0]);
      },
    });
    const panel = await screen.findByRole('region', { name: 'Brands' });
    const name = within(panel).getByRole('textbox', { name: 'New brand' });
    await user.type(name, 'B');
    await user.click(within(panel).getByRole('button', { name: 'Add brand' }));
    expect(within(panel).getByText('Use 2 to 120 characters')).toBeInTheDocument();
    await user.type(name, 'erger ');
    await user.click(within(panel).getByRole('button', { name: 'Add brand' }));
    expect(await within(panel).findByText('Berger')).toBeInTheDocument();
    expect(name).toHaveValue('');
    expect(screen.getByText('Added')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Rename Asian Paints' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename Asian Paints' });
    const field = within(dialog).getByRole('textbox', { name: 'Name' });
    await user.clear(field);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText('Use 2 to 120 characters')).toBeInTheDocument();
    await user.type(field, 'Asian Paints Ltd');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    // Deactivating is confirmed first; cancelling sends nothing.
    await user.click(within(panel).getByRole('button', { name: 'Deactivate Asian Paints' }));
    const confirm = screen.getByRole('dialog', { name: 'Deactivate Asian Paints?' });
    expect(
      within(confirm).getByText(
        'Its products stay as they are, but it is no longer offered for new products. You can activate it again at any time.',
      ),
    ).toBeVisible();
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(bodies).toHaveLength(2);
    await user.click(within(panel).getByRole('button', { name: 'Deactivate Asian Paints' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Deactivate Asian Paints?' })).getByRole('button', {
        name: 'Deactivate',
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // Activating again needs no confirmation.
    await user.click(within(panel).getByRole('button', { name: 'Activate Old Brand' }));
    await waitFor(() => {
      expect(bodies).toHaveLength(4);
    });
    expect(bodies).toEqual([
      { name: 'Berger' },
      { name: 'Asian Paints Ltd' },
      { isActive: false },
      { isActive: true },
    ]);
  });

  it('shows why a brand could not be added or changed', async () => {
    const { user } = renderSetup({
      'POST /brands': () => json({ message: 'Brand Asian Paints already exists' }, 409),
      'PATCH /brands/:id': () => json({ message: 'Server error' }, 500),
    });
    const panel = await screen.findByRole('region', { name: 'Brands' });
    await user.type(within(panel).getByRole('textbox', { name: 'New brand' }), 'asian paints');
    await user.click(within(panel).getByRole('button', { name: 'Add brand' }));
    expect(await within(panel).findByText('Brand Asian Paints already exists')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Deactivate Asian Paints' }));
    const confirm = screen.getByRole('dialog', { name: 'Deactivate Asian Paints?' });
    await user.click(within(confirm).getByRole('button', { name: 'Deactivate' }));
    expect(await within(confirm).findByText('Server error')).toBeInTheDocument();
  });

  it('shows why a brand could not be activated again', async () => {
    const { user } = renderSetup({
      'PATCH /brands/:id': () => json({ message: 'Server error' }, 500),
    });
    const panel = await screen.findByRole('region', { name: 'Brands' });
    await user.click(within(panel).getByRole('button', { name: 'Activate Old Brand' }));
    expect(await screen.findByText('Server error')).toBeInTheDocument();
  });

  it('adds a subcategory and renames a category', async () => {
    const categories: Category[] = [...CATEGORIES];
    const bodies: unknown[] = [];
    const { user } = renderSetup({
      'GET /categories': () => json(categories),
      'POST /categories': (request) => {
        bodies.push(request.body);
        categories.push({
          id: 'cat-new',
          name: 'Exterior emulsions',
          parentId: 'cat-emulsion',
          isActive: true,
        });
        return json(categories.at(-1), 201);
      },
      'PATCH /categories/:id': (request) => {
        bodies.push(request.body);
        return json(categories[0]);
      },
    });
    const panel = await screen.findByRole('region', { name: 'Categories' });
    await user.type(
      within(panel).getByRole('textbox', { name: 'New category' }),
      'Exterior emulsions',
    );
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'Inside' }), 'Emulsions');
    await user.click(within(panel).getByRole('button', { name: 'Add category' }));
    expect(await within(panel).findByText('Emulsions › Exterior emulsions')).toBeInTheDocument();
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'Inside' }), 'Top level');
    await user.type(within(panel).getByRole('textbox', { name: 'New category' }), 'Primers');
    await user.click(within(panel).getByRole('button', { name: 'Add category' }));
    await user.click(within(panel).getByRole('button', { name: 'Rename Emulsions' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename Emulsions' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), ' (water based)');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(bodies).toHaveLength(3);
    });
    expect(bodies).toEqual([
      { name: 'Exterior emulsions', parentId: 'cat-emulsion' },
      { name: 'Primers' },
      { name: 'Emulsions (water based)' },
    ]);
  });

  it('deactivates and reactivates categories, and says which take no new products', async () => {
    let categories: Category[] = [
      ...CATEGORIES,
      { id: 'cat-primer', name: 'Primers', parentId: null, isActive: false },
      { id: 'cat-wall', name: 'Wall primers', parentId: 'cat-primer', isActive: true },
    ];
    const bodies: unknown[] = [];
    let fail = false;
    const { user } = renderSetup({
      'GET /categories': () => json(categories),
      'PATCH /categories/:id': (request) => {
        if (fail) return json({ message: 'Server error' }, 500);
        bodies.push({ id: request.path.split('/').at(-1), ...(request.body as object) });
        const { isActive } = request.body as { isActive: boolean };
        categories = categories.map((category) =>
          request.path.endsWith(category.id) ? { ...category, isActive } : category,
        );
        return json(categories[0]);
      },
    });
    const panel = await screen.findByRole('region', { name: 'Categories' });
    const row = (name: string) =>
      found(within(panel).getByText(name, { selector: '.record-list__title' }).closest('li'));
    expect(within(row('Primers')).getByText('Inactive')).toBeVisible();
    expect(
      within(row('Primers › Wall primers')).getByText('No new products: its category is inactive'),
    ).toBeVisible();

    await user.click(within(panel).getByRole('button', { name: 'Deactivate Emulsions' }));
    const confirm = screen.getByRole('dialog', { name: 'Deactivate Emulsions?' });
    expect(
      within(confirm).getByText(
        'Its products stay as they are, but it and its subcategories take no new products. You can activate it again at any time.',
      ),
    ).toBeVisible();
    await user.click(within(confirm).getByRole('button', { name: 'Deactivate' }));
    expect(await within(row('Emulsions')).findByText('Inactive')).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Activate Primers' }));
    await waitFor(() => {
      expect(within(row('Primers')).queryByText('Inactive')).toBeNull();
    });
    expect(bodies).toEqual([
      { id: 'cat-emulsion', isActive: false },
      { id: 'cat-primer', isActive: true },
    ]);

    fail = true;
    await user.click(within(panel).getByRole('button', { name: 'Deactivate Primers' }));
    const failing = screen.getByRole('dialog', { name: 'Deactivate Primers?' });
    await user.click(within(failing).getByRole('button', { name: 'Deactivate' }));
    expect(await within(failing).findByText('Server error')).toBeInTheDocument();
    await user.click(within(failing).getByRole('button', { name: 'Cancel' }));
    await user.click(within(panel).getByRole('button', { name: 'Activate Emulsions' }));
    expect(await screen.findByText('Server error')).toBeInTheDocument();
  });

  it('says when there are none yet, and is read-only without catalogue rights', async () => {
    renderSetup({ 'GET /brands': () => json([]), 'GET /categories': () => json([]) }, CASHIER);
    expect(await screen.findByText('No brands yet')).toBeInTheDocument();
    expect(await screen.findByText('No categories yet')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows a loading problem', async () => {
    renderSetup({ 'GET /brands': () => json({ message: 'Down' }, 503) });
    expect(await screen.findByText('Could not load brands and categories')).toBeInTheDocument();
  });
});
