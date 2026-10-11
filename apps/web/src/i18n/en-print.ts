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
    settings: {
      title: 'Invoice print',
      description:
        'The bank details and terms printed on your invoices. The logo comes from Appearance.',
      error: 'Could not load the invoice print settings',
      bank: {
        title: 'Bank details',
        description:
          'Printed on A4 invoices, so customers can pay by bank transfer. Leave every field empty to print none.',
        bankName: 'Bank and branch',
        accountName: 'Account name',
        accountNumber: 'Account number',
        ifsc: 'IFSC',
        upiId: 'UPI ID',
        upiHint: 'Optional; printed with the bank details',
      },
      terms: {
        title: 'Terms and conditions',
        label: 'Terms',
        hint: 'One per line, at most {max}, each up to {length} characters. Printed on every invoice.',
      },
      save: 'Save',
      saved: 'Invoice print settings saved',
      problems: {
        incomplete: 'Fill in all four bank fields, or leave them all empty',
        accountNumber: 'Use the account number: 9 to 18 digits',
        ifsc: 'Use an IFSC like SBIN0020345',
        upiId: 'Use a UPI ID like shop@bank',
        upiWithoutBank: 'Add the bank details to print a UPI ID',
        tooManyTerms: 'At most {max} terms',
        termTooLong: 'Each term can be at most {length} characters',
      },
    },
  },
};
