import { QUICK_ACTIONS } from '@paint/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SearchResults } from '../api/types.js';
import { OWNER, json } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { actionHit, resultGroups } from './SearchBox.js';
import { SHORTCUT_WINDOW_MS, createShortcutMatcher, isTyping } from './shortcuts.js';

const ACTIONS = QUICK_ACTIONS.slice(0, 2);

const RESULTS: SearchResults = {
  query: 'apex',
  actions: [],
  parties: [{ id: 'p1', title: 'Apex Builders', subtitle: '+91 98765 43210', path: '/parties/p1' }],
  products: [
    { id: 'v1', title: 'Asian Paints Apex 1 l', subtitle: 'APX-1L', path: '/products/v1' },
    { id: 'v2', title: 'Asian Paints Apex 4 l', subtitle: null, path: '/products/v2' },
  ],
  leads: null,
  opportunities: [],
  projects: null,
  contracts: [
    { id: 'c1', title: 'Apex Towers rate contract', subtitle: null, path: '/contracts/c1' },
  ],
  loyalty: [
    { id: 'l1', title: 'Apex Painters', subtitle: '1,250 points', path: '/parties/p9/loyalty' },
  ],
  documents: [],
};

const location = () => screen.getByTestId('location').textContent;

function renderShell(search: (q: string) => ReturnType<typeof json> = () => json(RESULTS)) {
  return renderApp({
    path: '/parties',
    routes: {
      'GET /auth/me': () => json(OWNER),
      'GET /search/actions': () => json(ACTIONS),
      'GET /search': (request) => search(String(request.query.get('q'))),
    },
  });
}

describe('resultGroups', () => {
  it('keeps groups in order and leaves out empty or hidden ones', () => {
    const groups = resultGroups({ ...RESULTS, actions: [QUICK_ACTIONS[0] as never] });
    expect(groups.map((group) => group.key)).toEqual([
      'actions',
      'parties',
      'products',
      'contracts',
      'loyalty',
    ]);
    expect(actionHit(QUICK_ACTIONS[0] as never)).toEqual({
      id: 'new_customer',
      title: '+ Customer',
      subtitle: 'N C',
      path: '/parties/new',
    });
  });
});

describe('SearchBox', () => {
  it('offers quick actions on focus and opens one with the keyboard', async () => {
    const { user } = renderShell();
    const box = await screen.findByRole('combobox', { name: 'Search' });
    await user.click(box);
    const list = await screen.findByRole('listbox');
    expect(within(list).getByRole('group', { name: 'Quick actions' })).toBeInTheDocument();
    const options = within(list).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['+ CustomerN C', '+ LeadN L']);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(box).toHaveAttribute('aria-activedescendant', options[1]?.id);
    await user.keyboard('{ArrowDown}');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(location()).toBe('/leads/new');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('asks for two characters, then shows grouped results to click', async () => {
    const { user, requests } = renderShell();
    const box = await screen.findByRole('combobox', { name: 'Search' });
    await user.type(box, 'a');
    expect(await screen.findByText('Type at least 2 characters')).toBeInTheDocument();
    await user.type(box, 'pex');
    expect(await screen.findByRole('group', { name: 'Customers & parties' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Products' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Leads' })).toBeNull();
    expect(
      within(screen.getByRole('group', { name: 'Loyalty' })).getByRole('option'),
    ).toHaveTextContent('Apex Painters1,250 points');
    expect(
      requests
        .filter((request) => request.path === '/search')
        .map((request) => request.query.get('q')),
    ).toEqual(['apex']);
    await user.click(screen.getByRole('option', { name: /Apex 4 l/ }));
    expect(location()).toBe('/products/v2');
    expect(box).toHaveValue('');
  });

  it('says when nothing matches or search fails', async () => {
    const { user } = renderShell((q) =>
      q === 'zzz'
        ? json({ ...RESULTS, parties: [], products: [], contracts: [], loyalty: null })
        : json({ statusCode: 500, message: 'Search down' }, 500),
    );
    const box = await screen.findByRole('combobox', { name: 'Search' });
    await user.type(box, 'zzz');
    expect(await screen.findByText('Nothing found for “zzz”')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    await user.clear(box);
    await user.type(box, 'broken');
    expect(await screen.findByText('Search is not working right now')).toBeInTheDocument();
  });

  it('closes with Escape, clears with a second Escape, and reopens with the arrow keys', async () => {
    const { user } = renderShell();
    const box = await screen.findByRole('combobox', { name: 'Search' });
    await user.type(box, 'ap');
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box).toHaveValue('ap');
    await user.keyboard('{Escape}');
    expect(box).toHaveValue('');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Shift}');
    await user.tab();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('ignores Enter while there is nothing to choose', async () => {
    const { user } = renderShell(() =>
      json({ ...RESULTS, parties: [], products: [], contracts: [], loyalty: null }),
    );
    const box = await screen.findByRole('combobox', { name: 'Search' });
    await user.type(box, 'none');
    await screen.findByText('Nothing found for “none”');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(location()).toBe('/parties');
  });
});

describe('keyboard shortcuts', () => {
  it('matches two keys pressed in quick succession', () => {
    let now = 0;
    const match = createShortcutMatcher(() => now);
    expect(match(QUICK_ACTIONS, 'n')).toBeNull();
    now = 500;
    expect(match(QUICK_ACTIONS, 'c')?.key).toBe('new_customer');
    // Too slow: the second key starts over.
    expect(match(QUICK_ACTIONS, 'n')).toBeNull();
    now += SHORTCUT_WINDOW_MS + 1;
    expect(match(QUICK_ACTIONS, 'c')).toBeNull();
    // Not a shortcut.
    expect(match(QUICK_ACTIONS, 'x')).toBeNull();
    expect(createShortcutMatcher()(QUICK_ACTIONS, 'g')).toBeNull();
  });

  it('knows when keys are being typed into a field', () => {
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTyping(editable)).toBe(true);
    expect(isTyping(document.createElement('input'))).toBe(true);
    expect(isTyping(document.createElement('textarea'))).toBe(true);
    expect(isTyping(document.createElement('select'))).toBe(true);
    expect(isTyping(document.createElement('button'))).toBe(false);
    expect(isTyping(null)).toBe(false);
  });

  it('opens search with "/" and quick actions with their keys, but not while typing', async () => {
    renderShell();
    const box = await screen.findByRole('combobox', { name: 'Search' });
    await waitFor(() => {
      expect(screen.getByText('Coming soon')).toBeInTheDocument();
    });
    fireEvent.keyDown(document.body, { key: '/' });
    expect(box).toHaveFocus();
    fireEvent.keyDown(box, { key: 'n' });
    fireEvent.keyDown(box, { key: 'c' });
    expect(location()).toBe('/parties');
    box.blur();
    fireEvent.keyDown(document.body, { key: 'n', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'Shift' });
    // Quick actions arrive from the API before shortcuts work.
    await waitFor(() => {
      fireEvent.keyDown(document.body, { key: 'n' });
      fireEvent.keyDown(document.body, { key: 'l' });
      expect(location()).toBe('/leads/new');
    });
  });
});
