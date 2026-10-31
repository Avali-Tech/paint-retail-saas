// English messages for setting a business up: Settings → Stores and Settings → Billing go-live
// (MVP 3 round 7a, PO-100 and PO-102; spread into en.ts).

export const setupEn = {
  storeSettings: {
    nav: 'Stores',
    title: 'Stores and godowns',
    description:
      'Add a store or godown, rename it, set its GST registration and address, or close it',
    error: 'Could not load the stores',
    access:
      'Owners and admins work at every store and see a new one at once. Give other members access under Team.',
    list: 'Stores',
    empty: 'No stores yet. Add the first one.',
    add: 'New store',
    closed: 'Closed',
    noState: 'No state yet',
    actions: 'Actions for {name}',
    edit: 'Edit',
    editLabel: 'Edit {name}',
    gst: 'GST and address',
    gstLabel: 'GST registration and address of {name}',
    close: 'Close',
    closeLabel: 'Close {name}',
    reopen: 'Reopen',
    reopenLabel: 'Reopen {name}',
    reopened: 'Store reopened',
    kinds: { store: 'Store', godown: 'Godown' },
    form: {
      createTitle: 'New store',
      editTitle: 'Edit {name}',
      name: 'Name',
      nameInvalid: 'Use 2 to 120 characters',
      code: 'Code',
      codeHint:
        'Printed on invoice numbers, such as HYD1. Up to 5 letters or digits; it cannot change later.',
      codeInvalid: 'Use up to 5 letters or digits (dashes are allowed)',
      kind: 'Kind',
      gstSection: 'GST registration and address',
      gstHint: 'Invoices print these. Documents already issued keep what they printed.',
      create: 'Add store',
      save: 'Save',
      created: 'Store added',
      saved: 'Store saved',
    },
    closeDialog: {
      title: 'Close {name}?',
      description:
        'A closed store leaves the store pickers and does not count against your plan. Its stock, documents and history stay; you can reopen it later.',
      submit: 'Close store',
      done: 'Store closed',
    },
  },
  goLive: {
    nav: 'Billing go-live',
    title: 'Billing go-live',
    description:
      'The day billing starts: opening balances move into each customer’s ledger, and credit, overdue days and ageing come from the ledger from then on',
    error: 'Could not load the go-live',
    live: {
      title: 'Billing is live',
      since: 'Billing went live on {date}.',
      posted: 'Opening balances posted',
      postedValue: '{count} customers · {amount}',
      next: 'Open receivables',
      fixes:
        'The date and the opening balances cannot change now. Correct a balance with a credit or debit note.',
    },
    date: {
      title: '1. Go-live date',
      label: 'Go live on',
      hint: 'Today or an earlier day. It cannot be changed after you go live.',
      invalid: 'Choose today or an earlier day',
    },
    openings: {
      title: '2. Opening balances',
      intro:
        'What each customer owes on the go-live day. Import them from the old books (such as Tally), then check and correct them here.',
      import: 'Import opening balances',
      add: 'Add a customer',
      pick: 'Add an opening balance',
      blankRule:
        'Leave “overdue since” blank when none of it is late: the credit check and reminders treat the balance as current, while receivables ageing counts it from the go-live date.',
      table: 'Opening balances',
      party: 'Customer',
      source: 'From',
      amount: 'Owed on the go-live day',
      overdueSince: 'Overdue since',
      notOverdue: 'Not overdue',
      edit: 'Edit',
      editLabel: 'Edit the opening balance of {name}',
      empty: 'No opening balances yet. Import them, or add customers one by one.',
      sources: {
        import: 'Imported',
        manual: 'Entered on the credit panel',
        here: 'Changed here',
      },
    },
    dialog: {
      title: 'Opening balance: {name}',
      amount: 'Owed on the go-live day (₹)',
      amountHint: '0 for nothing owed',
      amountInvalid: 'Enter an amount in rupees, such as 1250.50',
      overdueSince: 'Overdue since',
      overdueHint:
        'The day the oldest unpaid part fell due. Blank: none of it is late (see the note above).',
      overdueInvalid: 'Choose today or an earlier day',
      overdueNothing: 'Only for a customer who owes something',
      save: 'Use this balance',
    },
    review: {
      title: '3. Review and go live',
      customers: 'Customers with a balance',
      total: 'Total owed',
      overdue: 'Customers with an overdue date',
      loyalty: 'Loyalty accounts whose manual purchase entry stops',
      unsaved:
        'Changes made here are kept on this page only until you go live; reloading it drops them.',
      start: 'Go live on {date}',
    },
    confirm: {
      title: 'Go live on {date}?',
      warning:
        'This cannot be undone. The date and these opening balances become permanent ledger entries, and the hand-entered credit figures become read-only.',
      summary: '{count} opening balances, {amount} in all.',
      checked: 'I have checked these opening balances against the old books',
      checkFirst: 'Tick the box once the balances are checked',
      submit: 'Go live',
      done: 'Billing is live',
    },
  },
  gettingStarted: {
    title: 'Getting started',
    description: 'Set your business up step by step. Each step ticks itself off once it is done.',
    error: 'Could not load the checklist',
    progress: '{done} of {total} done',
    steps: 'Steps',
    done: 'Done',
    todo: 'To do',
    open: 'Open',
    openStep: 'Open: {step}',
    complete: 'Everything is set up.',
    seeAll: 'See all',
    hide: 'Hide',
    step: {
      stores_gst: {
        title: 'Stores and GST',
        hint: 'Add each store with its state and GST registration',
      },
      products: { title: 'Import products', hint: 'Bring in your catalogue from a spreadsheet' },
      customers: {
        title: 'Import customers',
        hint: 'Bring in customers, contractors and painters from a spreadsheet',
      },
      opening_stock: { title: 'Opening stock', hint: 'Import what each store has on its shelves' },
      team: { title: 'Your team', hint: 'Invite the people who work with you' },
      credit_rules: {
        title: 'Credit rules',
        hint: 'Decide who approves credit and when an account is held',
      },
      billing_live: {
        title: 'Billing go-live',
        hint: 'Post the opening balances and start billing',
      },
      invoice_print: {
        title: 'Invoice print and branding',
        hint: 'Bank details and terms for the invoice; your logo under Appearance',
      },
      payment_links: {
        title: 'Payment links',
        hint: 'Connect a payment gateway so customers can pay by UPI link',
      },
    },
  },
};
