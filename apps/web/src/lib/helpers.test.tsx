import { screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { RequireAuth } from '../shell/guards.js';
import { StoreSelect, storeLabel, useStoreAccess } from '../stock/StoreSelect.js';
import { json, profile } from '../test-support/fake-api.js';
import { STORES } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { RequireAnyPermission } from './guard.js';
import { ReasonDialog } from './ReasonDialog.js';
import { SectionNav } from './SectionNav.js';

function renderWith(element: ReactNode, member = profile()) {
  return renderApp({
    routes: { 'GET /auth/me': () => json(member), 'GET /stores': () => json(STORES) },
    element: <RequireAuth>{element}</RequireAuth>,
  });
}

describe('RequireAnyPermission', () => {
  it('shows the page to members holding any of the permissions', async () => {
    renderWith(
      <RequireAnyPermission permissions={['catalog:manage', 'inventory:manage']}>
        <p>Import page</p>
      </RequireAnyPermission>,
      profile(['inventory:manage']),
    );
    expect(await screen.findByText('Import page')).toBeInTheDocument();
  });

  it('explains when the member holds none of them', async () => {
    renderWith(
      <RequireAnyPermission permissions={['catalog:manage', 'inventory:manage']}>
        <p>Import page</p>
      </RequireAnyPermission>,
      profile(['stores:read']),
    );
    expect(await screen.findByText('No access')).toBeInTheDocument();
    expect(screen.queryByText('Import page')).toBeNull();
  });
});

describe('SectionNav', () => {
  it('links only to the screens the member may open', async () => {
    renderWith(
      <SectionNav
        label="stock.sections.label"
        links={[
          { to: '/stock', label: 'stock.sections.balances', permission: 'inventory:read' },
          { to: '/purchase-orders', label: 'purchasing.orders', permission: 'purchasing:read' },
        ]}
      />,
      profile(['inventory:read']),
    );
    const nav = await screen.findByRole('navigation', { name: 'Stock sections' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Balances']);
  });
});

function StorePickerDemo() {
  const [storeId, setStoreId] = useState('');
  const access = useStoreAccess();
  return (
    <>
      <StoreSelect
        label="Send to"
        emptyLabel="Choose"
        value={storeId}
        onChange={setStoreId}
        exclude="store-hyd"
        error={storeId === '' ? 'Pick one' : undefined}
      />
      <output>
        {STORES.map((store) => `${store.code}:${String(access(store.id))}`).join(' ')}
      </output>
    </>
  );
}

describe('StoreSelect and store access', () => {
  it('offers the member’s stores except the excluded one', async () => {
    const { user } = renderWith(
      <StorePickerDemo />,
      profile(undefined, { allStores: false, storeIds: ['store-pun'] }),
    );
    const select = await screen.findByRole('combobox', { name: 'Send to' });
    expect(select).toHaveAccessibleDescription('Pick one');
    await screen.findByRole('option', { name: 'PUN · Pune' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose', 'PUN · Pune']);
    await user.selectOptions(select, 'PUN · Pune');
    expect(select).not.toHaveAccessibleDescription();
    expect(screen.getByText('HYD:false PUN:true')).toBeInTheDocument();
    expect(storeLabel(STORES[0] ?? { code: '', name: '' })).toBe('HYD · Hyderabad');
  });

  it('treats all-store members as working everywhere', async () => {
    renderWith(<StorePickerDemo />);
    expect(await screen.findByText('HYD:true PUN:true')).toBeInTheDocument();
  });
});

describe('ReasonDialog', () => {
  it('needs a reason of three characters, then saves and closes', async () => {
    const reasons: string[] = [];
    let open = true;
    const { user } = renderWith(
      <ReasonDialog
        title="Reject TR-000001"
        description="The requesting store is told why."
        submitLabel="Reject"
        onSubmit={(reason) => {
          reasons.push(reason);
          return Promise.resolve();
        }}
        onClose={() => {
          open = false;
        }}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Reject TR-000001' });
    expect(dialog).toHaveAccessibleDescription('The requesting store is told why.');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'no');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Give a reason of at least 3 characters',
    );
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 't needed ');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(open).toBe(false);
    });
    expect(reasons).toEqual(['not needed']);
  });

  it('shows why saving failed', async () => {
    const { user } = renderWith(
      <ReasonDialog
        title="Cancel PO-000001"
        submitLabel="Cancel order"
        onSubmit={() => Promise.reject(new Error('boom'))}
        onClose={() => undefined}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Cancel PO-000001' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Wrong supplier');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    );
  });
});
