import type { ListPageInfo } from '@paint/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test-support/render-app.js';
import { useUrlFilters } from './hooks.js';
import { ListPager, ListRefreshing } from './ListPager.js';

const rows = (count: number) => Array.from({ length: count }, (_, index) => index);

/** A list in the address: its pager, and a filter that starts the list again. */
function Harness({ page }: { readonly page: ListPageInfo & { items: readonly unknown[] } }) {
  const filters = useUrlFilters(['q'] as const);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          filters.set('q', 'reddy');
        }}
      >
        Filter
      </button>
      <output data-testid="cursor">{filters.cursor ?? 'none'}</output>
      <ListPager filters={filters} page={page} limit={50} label="Invoice pages" />
    </>
  );
}

const location = () => screen.getByTestId('location').textContent;

describe('ListPager', () => {
  it('pages forward by cursor and back by offset, with the range in Indian digits', async () => {
    const { user } = renderApp({
      path: '/invoices?offset=50&cursor=c-50',
      element: (
        <Harness
          page={{ items: rows(50), total: 1_234, totalCapped: false, nextCursor: 'c-100' }}
        />
      ),
    });
    const pages = await screen.findByRole('navigation', { name: 'Invoice pages' });
    expect(pages).toHaveTextContent('51–100 of 1,234');
    expect(screen.getByTestId('cursor')).toHaveTextContent('c-50');

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(location()).toBe('/invoices?offset=100&cursor=c-100');
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(location()).toBe('/invoices?offset=50');
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(location()).toBe('/invoices');
  });

  it('starts again from the first page when a filter changes', async () => {
    const { user } = renderApp({
      path: '/invoices?offset=100&cursor=c-100',
      element: (
        <Harness page={{ items: rows(1), total: 101, totalCapped: false, nextCursor: null }} />
      ),
    });
    expect(await screen.findByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    expect(location()).toBe('/invoices?q=reddy');
  });

  it('says "10,000+" past the count cap, and keeps going while the list has more', async () => {
    const { user } = renderApp({
      path: '/invoices?offset=10000&cursor=c-10000',
      element: (
        <Harness
          page={{ items: rows(50), total: 10_000, totalCapped: true, nextCursor: 'c-10050' }}
        />
      ),
    });
    const pages = await screen.findByRole('navigation', { name: 'Invoice pages' });
    expect(pages).toHaveTextContent('10,001–10,050 of 10,050+');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(location()).toBe('/invoices?offset=10050&cursor=c-10050');
  });
});

describe('ListRefreshing', () => {
  it('shows a spinner only while an older page stands in for the new one', async () => {
    renderApp({
      element: (
        <>
          <ListRefreshing query={{ isPlaceholderData: true } as UseQueryResult} />
          <ListRefreshing query={{ isPlaceholderData: false } as UseQueryResult} />
        </>
      ),
    });
    expect(await screen.findAllByRole('status', { name: 'Loading…' })).toHaveLength(1);
  });
});
