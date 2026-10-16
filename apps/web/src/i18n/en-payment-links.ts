// English messages for UPI payment links (MVP 3 round 4a, P2-M32; spread into en.ts).

export const paymentLinksEn = {
  paymentLinks: {
    send: 'Send payment link',
    sendName: 'Send a payment link to {name}',
    title: 'Payment links',
    description:
      'UPI links sent to customers, newest first; a paid link records its payment by itself.',
    panelTitle: 'UPI payment links',
    none: 'No payment link has been sent yet.',
    error: 'Could not load the payment links',
    table: 'Payment links',
    number: 'Link',
    customer: 'Customer',
    purpose: 'For',
    amount: 'Amount',
    paid: 'Paid',
    status: 'Status',
    expires: 'Payable until',
    actions: 'Actions',
    pages: 'Payment link pages',
    allStatuses: 'All',
    refunded: 'Refunded {amount}',
    refundPending: 'Refund of {amount} on its way',
    refundFailed: 'Refund of {amount} failed: kept as an advance',
    partPaid: 'Part paid',
    copy: 'Copy link',
    copyName: 'Copy link {number}',
    copied: 'Link copied',
    cancel: 'Cancel link',
    cancelName: 'Cancel link {number}',
    cancelled: 'Link cancelled: it can no longer be paid',
    open: 'Payment links',
    dialog: {
      title: 'Send a UPI payment link',
      description: 'The customer pays by UPI; the payment is recorded and allocated by itself.',
      invoice: 'For invoice {number}',
      purpose: 'Ask for',
      amount: 'Amount (₹)',
      amountHint: 'Leave empty to ask for everything owed.',
      amountAdvanceHint: 'An advance needs an amount.',
      amountInvalid: 'Enter an amount above zero, such as 2500',
      whatsapp: 'Also send it on WhatsApp',
      create: 'Make link',
    },
    result: {
      title: 'Payment link {number}',
      summary: '{amount}, payable until {date}.',
      sent: 'Sent on WhatsApp.',
      notSent: {
        no_consent:
          'Not sent on WhatsApp: the customer has not agreed to messages. Share it instead.',
        no_address: 'Not sent on WhatsApp: the customer has no mobile number. Share it instead.',
        duplicate: 'Already sent on WhatsApp.',
      },
      whatsapp: 'Share on WhatsApp',
      done: 'Done',
    },
    dayEnd: 'Money paid by UPI link goes to no register: find it under Payments, mode "UPI link".',
    dayEndLink: 'Payments by UPI link',
    statementLink: 'UPI payment link: {url}',
  },
  /** Settings, Payment links (round 4c, [PO-40] – [PO-43]). */
  paymentLinkSettings: {
    nav: 'Payment link settings',
    title: 'Payment links',
    description:
      'Connect your own Razorpay account, so UPI money goes straight to you, and set how links work.',
    error: 'Could not load the payment link settings',
    saved: 'Payment link settings saved',
    off: 'Payment links are not switched on for this service.',
    logGateway:
      'Links use the test gateway here: no money moves, and refunds are pretend too. Only the rules below apply.',
    account: {
      title: 'Razorpay account',
      description:
        'Money paid by link goes straight into your Razorpay account. Keys are kept encrypted and never shown again.',
      connectedLive: 'Connected · live',
      connectedTest: 'Connected · test',
      notConnected: 'Not connected',
      testWarning:
        'Test keys take no money, and Razorpay makes UPI-only links with live keys only. Use live keys for customers.',
      connectedBy: 'Connected by',
      verifiedAt: 'Last checked',
      test: 'Test connection',
      tested: 'Razorpay answered: the keys work',
      disconnect: 'Disconnect',
      disconnected: 'Razorpay disconnected: no new links until you connect again',
    },
    webhook: {
      title: 'Webhook',
      name: 'webhook address',
      description:
        'In Razorpay Dashboard → Accounts & Settings → Webhooks, add this address with the webhook secret you enter below.',
      events:
        'Enable these events: payment_link.paid, payment_link.expired, payment_link.cancelled, refund.processed, refund.failed.',
    },
    connect: {
      keyId: 'Key id',
      keySecret: 'Key secret',
      webhookSecret: 'Webhook secret',
      incomplete:
        'Enter the key id (rzp_live_… or rzp_test_…), the key secret and a webhook secret of at least 8 characters',
      submit: 'Connect Razorpay',
      replace: 'Replace keys',
      done: 'Razorpay connected',
      validityRaised:
        'Razorpay keeps a link payable for at least {minutes} minutes, so shorter links now last {minutes} minutes.',
    },
    rules: {
      title: 'How links work',
      validity: 'Payable for (minutes)',
      validityHint:
        'Links shown at the counter or shared by hand. Money paid later is still recorded.',
      messageValidity: 'Links in messages payable for (minutes)',
      messageValidityHint:
        'Links sent in reminders, statements and WhatsApp messages, read later: a day (1440) by default.',
      validityRange: 'Enter {min} to {max} minutes',
      gatewayMinimum: 'Razorpay keeps a link payable for at least {min} minutes.',
      cap: 'Most one link asks for (₹)',
      capHint: 'A link above this is refused. UPI takes at most {max} in one payment.',
      capRange: 'Enter {min} to {max}',
      basis: 'Links ask for',
      basisOption: {
        net: 'What is owed, less the advance',
        full: "The bills' full outstanding",
      },
      basisHint: {
        net: 'The link and the statement balance agree; the advance is used first.',
        full: 'The link asks for the bills in full; the statement names both figures.',
      },
      save: 'Save',
    },
  },
  /** The `log` provider's pretend payment page (development and demos only). */
  logCheckout: {
    title: 'Test payment page',
    notice:
      'This is a test gateway: no money moves. Paying sends the signed webhook a real gateway would.',
    error: 'This payment link does not exist.',
    business: 'Pay to',
    customer: 'Customer',
    link: 'Link',
    for: 'For',
    amount: 'Amount',
    paid: 'Paid so far',
    status: 'Status',
    payAmount: 'Amount to pay (₹)',
    amountInvalid: 'Enter an amount above zero',
    pay: 'Pay by UPI (test)',
    applied: 'Paid: the payment is recorded and allocated.',
    duplicate: 'Sent again: it was already recorded, so nothing changed.',
    ignored: 'Received, but nothing was recorded.',
    replay: 'Send the same payment again',
  },
};

export const paymentLinksEnumsEn = {
  paymentLinkStatus: {
    created: 'Open',
    paid: 'Paid',
    expired: 'Expired',
    cancelled: 'Cancelled',
  },
  paymentLinkPurpose: {
    invoice: 'Invoice',
    overdue: 'Overdue bills',
    outstanding: 'Everything owed',
    bills: 'Reminded bills',
    advance: 'Advance',
  },
};
