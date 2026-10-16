import {
  currentQuarter,
  type BrandProfitabilityRow,
  type BrandProfitabilityView,
  type MarginFigures,
} from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD, OWNER, json, profile } from '../test-support/fake-api.js';
import { HYD, STORES } from '../test-support/inventory-fixtures.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import { todayInIndia } from '../lib/india-time.js';
import { groupOf, periodDays, periodOf } from './BrandProfitabilityPage.js';
import { costOfMoneyBps, hundredths, pointValuePaise } from './profitability-input.js';

const location = () => screen.getByTestId('location').textContent;

const figures = (over: Partial<MarginFigures>): MarginFigures => ({
  invoicedPaise: 0,
  creditNotePaise: 0,
  netSalesPaise: 0,
  costPaise: 0,
  grossMarginPaise: 0,
  schemeReceivedPaise: 0,
  schemeExpectedPaise: 0,
  creditCostPaise: 0,
  loyaltyPaise: 0,
  painterPointsPaise: 0,
  contributionPaise: 0,
  marginBps: null,
  ...over,
});

const asian: BrandProfitabilityRow = {
  brandId: 'brand-asian',
  brandName: 'Asian Paints',
  uncostedLines: 1,
  figures: figures({
    netSalesPaise: 1_718_00,
    costPaise: 1_040_00,
    grossMarginPaise: 678_00,
    schemeReceivedPaise: 100_00,
    schemeExpectedPaise: 50_00,
    creditCostPaise: 9_39,
    loyaltyPaise: 13_00,
    painterPointsPaise: 13_00,
    contributionPaise: 792_61,
    marginBps: 4_614,
  }),
  slices: [],
};
const dulux: BrandProfitabilityRow = {
  brandId: 'brand-dulux',
  brandName: 'Dulux',
  uncostedLines: 0,
  figures: figures({ netSalesPaise: 100_00, costPaise: 150_00, contributionPaise: -50_00 }),
  slices: [],
};

const VIEW: BrandProfitabilityView = {
  from: '2026-07-01',
  to: '2026-09-30',
  groupBy: 'brand',
  costOfMoneyBps: 1_200,
  pointValuePaise: 100,
  settings: { costOfMoneyBps: 1_200, pointValuePaise: 100 },
  schemesCounted: false,
  brands: [asian, dulux],
  total: figures({ netSalesPaise: 1_818_00, contributionPaise: 742_61, marginBps: 4_085 }),
  uncostedLines: 1,
};

const BY_PRODUCT: BrandProfitabilityView = {
  ...VIEW,
  groupBy: 'product',
  schemesCounted: true,
  uncostedLines: 0,
  brands: [
    {
      ...asian,
      slices: [
        {
          ...asian.figures,
          productId: 'apex',
          productName: 'Apex Ultima',
          storeId: null,
          storeCode: null,
          storeName: null,
        },
        {
          ...figures({}),
          productId: null,
          productName: null,
          storeId: null,
          storeCode: null,
          storeName: null,
        },
      ],
    },
  ],
};

const BY_STORE: BrandProfitabilityView = {
  ...BY_PRODUCT,
  groupBy: 'store',
  brands: [
    {
      ...asian,
      slices: [
        {
          ...asian.figures,
          productId: null,
          productName: null,
          storeId: HYD.id,
          storeCode: HYD.code,
          storeName: HYD.name,
        },
      ],
    },
  ],
};

const EMPTY: BrandProfitabilityView = {
  ...VIEW,
  schemesCounted: true,
  brands: [],
  total: figures({}),
  uncostedLines: 0,
};

function routes(answer: (query: URLSearchParams) => unknown = () => VIEW) {
  return {
    'GET /auth/me': () => json(OWNER),
    'GET /stores': () => json(STORES),
    'GET /reports/brand-profitability': (request: { query: URLSearchParams }) =>
      json(answer(request.query)),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('helpers', () => {
  it('reads the period, the split and the cost of money from the address', () => {
    expect(periodOf('thisQuarter')).toBe('thisQuarter');
    expect(periodOf('custom')).toBe('custom');
    expect(periodOf('')).toBe('lastQuarter');
    expect(periodOf('decade')).toBe('lastQuarter');
    expect(groupOf('store')).toBe('store');
    expect(groupOf('customer')).toBe('brand');
    expect(costOfMoneyBps('12')).toBe(1_200);
    expect(costOfMoneyBps(' 9.5 ')).toBe(950);
    expect(costOfMoneyBps('100')).toBe(10_000);
    expect(costOfMoneyBps('100.01')).toBeUndefined();
    expect(costOfMoneyBps('')).toBeUndefined();
    expect(costOfMoneyBps('12%')).toBeUndefined();
    expect(pointValuePaise('1')).toBe(100);
    expect(pointValuePaise('0.5')).toBe(50);
    expect(pointValuePaise('1000')).toBe(100_000);
    expect(pointValuePaise('1000.01')).toBeUndefined();
    expect(pointValuePaise('-1')).toBeUndefined();
    expect(hundredths(1_200)).toBe('12');
    expect(hundredths(950)).toBe('9.5');
  });

  it('asks for the days of the period, or none for the last quarter', () => {
    expect(periodDays('lastQuarter', '2026-01-01', '2026-01-31', '2026-10-16')).toEqual({});
    expect(periodDays('thisQuarter', '', '', '2026-10-16')).toEqual({
      from: '2026-10-01',
      to: '2026-10-16',
    });
    expect(periodDays('custom', '2026-01-01', '2026-01-31', '2026-10-16')).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(periodDays('custom', '2026-02-01', '2026-01-31', '2026-10-16')).toEqual({});
    expect(periodDays('custom', '2026-01-01', '', '2026-10-16')).toEqual({});
    expect(periodDays('custom', 'soon', '2026-01-31', '2026-10-16')).toEqual({});
  });
});

describe('BrandProfitabilityPage', { timeout: 30_000 }, () => {
  it('answers which brand made the most money last quarter, with every component', async () => {
    const { requests } = renderApp({ path: '/reports/brand-profitability', routes: routes() });
    expect(
      await screen.findByRole('heading', { name: 'Brand profitability', level: 1 }),
    ).toBeVisible();
    const headline = await screen.findByRole('region', { name: 'Who made the most money' });
    expect(headline).toHaveTextContent('Asian Paints made the most money');
    expect(headline).toHaveTextContent('₹792.61 contribution · 46.14% margin');
    expect(screen.getByText(/Scheme money from brands is not counted yet/)).toBeVisible();
    expect(screen.getByText(/1 bill line had no cost price yet/)).toBeVisible();
    const table = screen.getByRole('table', { name: 'Contribution by brand' });
    const [head, first, second, foot] = within(table).getAllByRole('row');
    expect(head).toHaveTextContent(
      'BrandNet salesCost of salesGross marginSchemesCredit costPointsContributionMargin',
    );
    expect(first).toHaveTextContent(
      'Asian Paints₹1,718.00₹1,040.00₹678.00₹150.00₹9.39₹26.00₹792.6146.14%',
    );
    expect(second).toHaveTextContent('Dulux₹100.00₹150.00');
    expect(second).toHaveTextContent('-₹50.00—');
    expect(foot).toHaveTextContent('All brands₹1,818.00');
    expect(table.querySelector('[data-loss="true"]')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'How the figures are worked out' })).toBeVisible();
    expect(screen.getByText(/Net sales − cost \+ schemes − credit cost − points/)).toBeVisible();
    expect(requests.find((r) => r.path === '/reports/brand-profitability')?.query.toString()).toBe(
      '',
    );
  });

  it('narrows by period, store, split and cost of money, keeping them in the address', async () => {
    const { user, requests } = renderApp({
      path: '/reports/brand-profitability',
      routes: routes((query) =>
        query.get('groupBy') === 'store'
          ? BY_STORE
          : query.get('groupBy') === 'product'
            ? BY_PRODUCT
            : VIEW,
      ),
    });
    await screen.findByRole('table', { name: 'Contribution by brand' });
    const last = () =>
      requests
        .filter((r) => r.path === '/reports/brand-profitability')
        .at(-1)
        ?.query.toString();
    await user.selectOptions(screen.getByLabelText('Period'), 'thisQuarter');
    const quarter = currentQuarter(todayInIndia());
    await waitFor(() => {
      expect(last()).toBe(`from=${quarter.from}&to=${quarter.to}`);
    });
    await user.selectOptions(screen.getByLabelText('Period'), 'custom');
    await user.type(screen.getByLabelText('From'), '2026-04-01');
    await user.type(screen.getByLabelText('To'), '2026-06-30');
    await user.selectOptions(screen.getByLabelText('Store'), HYD.id);
    await user.selectOptions(screen.getByLabelText('Split by'), 'store');
    await user.type(screen.getByLabelText('Cost of money (% a year)'), '15');
    await waitFor(() => {
      expect(last()).toBe(
        `from=2026-04-01&to=2026-06-30&storeId=${HYD.id}&groupBy=store&costOfMoneyBps=1500`,
      );
    });
    expect(await screen.findByRole('rowheader', { name: 'HYD · Hyderabad' })).toBeVisible();
    expect(location()).toContain('period=custom');
    await user.selectOptions(screen.getByLabelText('Split by'), 'product');
    expect(await screen.findByRole('rowheader', { name: 'Apex Ultima' })).toBeVisible();
    expect(screen.getByRole('rowheader', { name: 'Brand schemes (no sales)' })).toBeVisible();
    expect(screen.queryByText(/not counted yet/)).toBeNull();
    await user.selectOptions(screen.getByLabelText('Split by'), 'brand');
    await user.selectOptions(screen.getByLabelText('Period'), 'lastQuarter');
    await waitFor(() => {
      expect(location()).not.toContain('period');
    });
    expect(location()).not.toContain('groupBy');
  });

  it('drills into a brand by product, and back to every brand', async () => {
    const { user, requests } = renderApp({
      path: '/reports/brand-profitability',
      routes: routes((query) => (query.get('brandId') === null ? VIEW : BY_PRODUCT)),
    });
    await user.click(await screen.findByRole('button', { name: 'Split Asian Paints by product' }));
    expect(await screen.findByText('Brand: Asian Paints')).toBeVisible();
    await waitFor(() => {
      expect(
        requests
          .filter((r) => r.path === '/reports/brand-profitability')
          .at(-1)
          ?.query.toString(),
      ).toBe('brandId=brand-asian&groupBy=product');
    });
    expect(screen.queryByRole('button', { name: /^Split / })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show all brands' }));
    await waitFor(() => {
      expect(screen.queryByText('Brand: Asian Paints')).toBeNull();
    });
  });

  it('draws no bars when every brand broke even', async () => {
    const even = { ...VIEW, brands: [{ ...dulux, figures: figures({}) }] };
    renderApp({ path: '/reports/brand-profitability', routes: routes(() => even) });
    const table = await screen.findByRole('table', { name: 'Contribution by brand' });
    expect(table.querySelector('.profit__bar')).toHaveStyle({ inlineSize: '0%' });
  });

  it('says when the period has no sales', async () => {
    renderApp({ path: '/reports/brand-profitability', routes: routes(() => EMPTY) });
    expect(await screen.findByText('No sales in this period')).toBeVisible();
    expect(screen.queryByRole('table', { name: 'Contribution by brand' })).toBeNull();
    expect(screen.queryByText(/no cost price/)).toBeNull();
  });

  it('downloads the figures on screen as CSV, and says when it cannot', async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:csv'), revokeObjectURL: vi.fn() });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    let answer = 0;
    const { user, requests } = renderApp({
      path: '/reports/brand-profitability?groupBy=store',
      routes: {
        ...routes(() => BY_STORE),
        'GET /reports/brand-profitability': (request: { query: URLSearchParams }) => {
          if (request.query.get('format') !== 'csv') return json(BY_STORE);
          answer += 1;
          if (answer === 1) {
            return {
              status: 200,
              raw: 'Brand\r\n',
              headers: {
                'content-disposition': 'attachment; filename="brand-profitability-x.csv"',
              },
            };
          }
          if (answer === 2) return { status: 200, raw: 'Brand\r\n' };
          return json({ statusCode: 403, message: 'No permission' }, 403);
        },
      },
    });
    const button = await screen.findByRole('button', { name: 'Download CSV' });
    await user.click(button);
    await waitFor(() => {
      expect(names).toEqual(['brand-profitability-x.csv']);
    });
    expect(requests.find((r) => r.query.get('format') === 'csv')?.query.toString()).toBe(
      'groupBy=store&format=csv',
    );
    await user.click(button);
    await waitFor(() => {
      expect(names).toEqual(['brand-profitability-x.csv', 'brand-profitability.csv']);
    });
    await user.click(button);
    expect(await screen.findByText('Could not download the report')).toBeVisible();
  });

  it('lets owners change the business’s cost of money and point value', async () => {
    let saved: unknown = null;
    const { user, requests } = renderApp({
      path: '/reports/brand-profitability',
      routes: {
        ...routes(),
        'PUT /reports/brand-profitability/settings': (request: { body: unknown }) => {
          saved = request.body;
          return json({ costOfMoneyBps: 1_500, pointValuePaise: 50 });
        },
      },
    });
    await screen.findByRole('table', { name: 'Contribution by brand' });
    expect(screen.getByLabelText('Cost of money (% a year)')).toHaveAttribute('placeholder', '12');
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Profitability settings' });
    const money = within(dialog).getByLabelText('Cost of money (% a year)');
    const point = within(dialog).getByLabelText('Value of one point (₹)');
    expect(money).toHaveValue('12');
    expect(point).toHaveValue('1');
    await user.clear(money);
    await user.type(money, '150');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(
        'Enter a cost of money from 0 to 100 % and a point value from ₹0 to ₹1,000',
      ),
    ).toBeVisible();
    await user.clear(money);
    await user.type(money, '15');
    await user.clear(point);
    await user.type(point, '0.5');
    const before = requests.filter((r) => r.path === '/reports/brand-profitability').length;
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Settings saved')).toBeVisible();
    expect(saved).toEqual({ costOfMoneyBps: 1_500, pointValuePaise: 50 });
    await waitFor(() => {
      expect(requests.filter((r) => r.path === '/reports/brand-profitability').length).toBe(
        before + 1,
      );
    });
  });

  it('shows the settings only to owners and admins', async () => {
    renderApp({
      path: '/reports/brand-profitability',
      routes: { ...routes(), 'GET /auth/me': () => json(profile(['accounting:export'])) },
    });
    await screen.findByRole('table', { name: 'Contribution by brand' });
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  });

  it('is only for those who see the books', async () => {
    renderApp({
      path: '/reports/brand-profitability',
      routes: { 'GET /auth/me': () => json(profile(['sales:read'])) },
    });
    expect(await screen.findByText('No access')).toBeVisible();
  });
});

describe('BrandProfitabilityTile', { timeout: 30_000 }, () => {
  const dashboard = (answer: () => ReturnType<typeof json>, me = OWNER) => ({
    'GET /auth/me': () => json(me),
    'GET /dashboard': () => json(DASHBOARD),
    'GET /reports/brand-profitability': answer,
  });

  it('names last quarter’s top brand on the dashboard, at the store chosen', async () => {
    const { requests } = renderApp({
      path: `/dashboard?store=${HYD.id}`,
      routes: dashboard(() => json(VIEW)),
    });
    const title = await screen.findByRole('heading', { name: 'Top brand last quarter' });
    const tile = found(title.closest('section'));
    expect(await within(tile).findByText('Asian Paints')).toBeVisible();
    expect(tile).toHaveTextContent('Contribution ₹793 · 46.14%');
    expect(within(tile).getByRole('link', { name: 'See brand profitability' })).toHaveAttribute(
      'href',
      `/reports/brand-profitability?storeId=${HYD.id}`,
    );
    expect(requests.find((r) => r.path === '/reports/brand-profitability')?.query.toString()).toBe(
      `storeId=${HYD.id}`,
    );
  });

  it('says when nothing sold, and leaves out a margin it cannot work out', async () => {
    renderApp({ path: '/', routes: dashboard(() => json(EMPTY)) });
    expect(await screen.findByText('No sales last quarter')).toBeVisible();
    expect(screen.getByRole('link', { name: 'See brand profitability' })).toHaveAttribute(
      'href',
      '/reports/brand-profitability',
    );
  });

  it('shows a brand with no margin, and an error when it cannot load', async () => {
    renderApp({
      path: '/',
      routes: dashboard(() => json({ ...VIEW, brands: [{ ...dulux, figures: figures({}) }] })),
    });
    const title = await screen.findByRole('heading', { name: 'Top brand last quarter' });
    const tile = found(title.closest('section'));
    expect(await within(tile).findByText('Dulux')).toBeVisible();
    expect(tile).not.toHaveTextContent('%');
  });

  it('says when it cannot load', async () => {
    renderApp({
      path: '/',
      routes: dashboard(() => json({ statusCode: 500, message: 'Down' }, 500)),
    });
    expect(await screen.findByText('Could not load brand profitability')).toBeVisible();
  });

  it('is not shown to those who do not see the books', async () => {
    renderApp({
      path: '/',
      routes: dashboard(() => json(VIEW), profile(['inventory:read', 'stores:read'])),
    });
    expect(await screen.findByRole('table', { name: 'Stores' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Top brand last quarter' })).toBeNull();
  });
});
