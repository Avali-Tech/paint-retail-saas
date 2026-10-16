// English messages for brand profitability (spread into en.ts).

export const brandProfitabilityEn = {
  /** Which brand makes the business money (GET /reports/brand-profitability, P2-M35). */
  brandProfitability: {
    nav: 'Brand profitability',
    title: 'Brand profitability',
    description: 'What each brand really earned you, after cost, credit and points.',
    error: 'Could not load brand profitability',
    filters: 'Filters',
    period: 'Period',
    from: 'From',
    to: 'To',
    allStores: 'All my stores',
    splitBy: 'Split by',
    costOfMoney: 'Cost of money (% a year)',
    costOfMoneyHint: 'What money tied up with customers costs you; 12 % if left empty',
    brandFilter: 'Brand: {name}',
    allBrands: 'Show all brands',
    split: 'Split {name} by product',
    csv: 'Download CSV',
    csvFailed: 'Could not download the report',
    periodRange: '{from} to {to}',
    headline: {
      label: 'Who made the most money',
      winner: '{brand} made the most money',
      figures: '{contribution} contribution · {margin} margin',
      none: 'No sales in this period',
      noneHint: 'Pick another period or store.',
    },
    schemesNotCounted:
      'Scheme money from brands is not counted yet: it joins these figures once brand schemes are set up.',
    uncosted: {
      one: '{count} bill line had no cost price yet and counts at zero cost.',
      other: '{count} bill lines had no cost price yet and count at zero cost.',
    },
    table: 'Contribution by brand',
    columns: {
      brand: 'Brand',
      netSales: 'Net sales',
      cost: 'Cost of sales',
      grossMargin: 'Gross margin',
      schemes: 'Schemes',
      creditCost: 'Credit cost',
      points: 'Points',
      contribution: 'Contribution',
      margin: 'Margin',
    },
    total: 'All brands',
    noProduct: 'Brand schemes (no sales)',
    explain: {
      title: 'How the figures are worked out',
      netSales:
        'Taxable value of the bills of the period (before GST), less the credit notes against them.',
      cost: 'What the units sold cost you at your average cost when billed, less the units that came back to the shelf.',
      schemes:
        'Rebates and other scheme money from the brand, received and still expected, shared over its products and stores by cost.',
      creditCost:
        'Money your customers owed on these brands, for each day it stayed unpaid in the period, at your cost of money.',
      points: 'Loyalty points to customers and painter points earned on the brand’s sales.',
      contribution: 'Net sales − cost + schemes − credit cost − points: what the brand left you.',
      margin: 'Contribution as a share of net sales.',
    },
    tile: {
      title: 'Top brand last quarter',
      none: 'No sales last quarter',
      open: 'See brand profitability',
    },
  },
};

export const brandProfitabilityEnumsEn = {
  profitabilityPeriods: {
    lastQuarter: 'Last quarter',
    thisQuarter: 'This quarter',
    custom: 'Choose dates',
  },
  profitabilityGroups: {
    brand: 'Brand only',
    product: 'Product',
    store: 'Store',
  },
};
