// English messages for the invoice print preview (spread into en.ts). The printed
// invoice's own labels come from @paint/shared (invoice-print/labels.ts), which the API's PDF shares.

export const printEn = {
  print: {
    title: 'Invoice print preview',
    description:
      'A sample invoice in your business’s name and logo, as it prints on A4 paper and on an 80 mm counter printer.',
    sampleNotice: 'Sample data. Issued invoices will print from their own page.',
    print: 'Print',
    options: 'Preview options',
    format: 'Paper',
    formats: { a4: 'A4', thermal: 'Thermal 80 mm' },
    sample: 'Sample',
    samples: {
      b2b: 'Registered buyer, same state',
      b2bInter: 'Registered buyer, other state',
      b2c: 'Walk-in customer',
      billOfSupply: 'Bill of supply (composition dealer)',
    },
    secondLanguage: 'Second language on the invoice',
    noSecondLanguage: 'None',
    copy: 'Copy mark',
    copies: {
      none: 'None',
      original: 'Original for recipient',
      duplicate: 'Duplicate for transporter',
      triplicate: 'Triplicate for supplier',
    },
    longInvoice: 'Long invoice (40 lines)',
  },
};
