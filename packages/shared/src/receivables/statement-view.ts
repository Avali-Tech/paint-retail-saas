import { formatAmount, formatPrintDate } from '../invoice-print/format.js';
import {
  fillLabel,
  type PrintLabel,
  type PrintLanguage,
  type SecondLanguage,
} from '../invoice-print/labels.js';
import { payLinkText } from '../messaging/templates.js';
import { formatINR } from '../money.js';
import { AGEING_BUCKETS, type AgeingBucket } from './ageing.js';
import type { StatementData } from './api.js';
import { statementLabels, type StatementLabels } from './statement-labels.js';

/**
 * A party's statement ready to print (roadmap P2-M12): every date, amount and label
 * formatted, so the web app's A4 page and the API's PDF draw the same thing. Balances
 * read the accountant's way: what the party owes is "Dr", what it paid ahead is "Cr".
 */

export interface StatementRow {
  readonly date: string;
  /** The entry's kind, in English. */
  readonly particulars: string;
  readonly reference: string | null;
  readonly note: string | null;
  /** Empty when the entry is a credit. */
  readonly debit: string;
  /** Empty when the entry is a debit. */
  readonly credit: string;
  readonly balance: string;
}

export interface StatementAgeingRow {
  readonly key: AgeingBucket | 'outstanding' | 'advance' | 'net';
  readonly label: PrintLabel;
  readonly amount: string;
  /** The totals print bold. */
  readonly strong: boolean;
}

export interface StatementOpenItemRow {
  /** The bill's number, or its kind when it has none (an opening balance). */
  readonly reference: string;
  readonly date: string;
  readonly dueOn: string;
  readonly daysPastDue: string;
  readonly amount: string;
}

export interface StatementView {
  readonly secondLanguage: SecondLanguage | null;
  readonly labels: StatementLabels;
  readonly business: {
    readonly name: string;
    /** Printed under the name when it differs from it. */
    readonly legalName: string | null;
    readonly gstin: string | null;
    readonly address: string | null;
  };
  readonly party: StatementData['party'];
  /** "01 Apr 2026 – 11 Oct 2026". */
  readonly period: string;
  readonly generatedOn: string;
  readonly opening: string;
  readonly rows: readonly StatementRow[];
  readonly totalDebit: string;
  readonly totalCredit: string;
  readonly closing: string;
  /** The day the ageing is as of: the period's last day. */
  readonly ageingOn: string;
  readonly ageing: readonly StatementAgeingRow[];
  readonly openItems: readonly StatementOpenItemRow[];
}

/** A balance with its side: "1,234.50 Dr", "80.00 Cr", "0.00". */
function balanceText(paise: number): string {
  if (paise === 0) return formatAmount(0);
  return `${formatAmount(Math.abs(paise))} ${paise > 0 ? 'Dr' : 'Cr'}`;
}

/** The statement's print view, its labels in English and `second` (Hindi or Telugu) when given. */
export function buildStatementView(
  data: StatementData,
  second: SecondLanguage | null,
): StatementView {
  const labels = statementLabels(second);
  const { ageing } = data;
  const dates = { from: formatPrintDate(data.from), to: formatPrintDate(data.to) };
  const ageingRows: StatementAgeingRow[] = [
    ...AGEING_BUCKETS.map((bucket) => ({
      key: bucket,
      label: labels[`bucket_${bucket}`],
      amount: formatAmount(ageing.buckets[bucket]),
      strong: false,
    })),
    {
      key: 'outstanding',
      label: labels.outstanding,
      amount: formatAmount(ageing.outstandingPaise),
      strong: true,
    },
  ];
  if (ageing.unappliedPaise !== 0) {
    ageingRows.push({
      key: 'advance',
      label: labels.advance,
      amount: formatAmount(ageing.unappliedPaise),
      strong: false,
    });
  }
  ageingRows.push({
    key: 'net',
    label: labels.netBalance,
    amount: balanceText(ageing.netPaise),
    strong: true,
  });
  return {
    secondLanguage: second,
    labels,
    business: {
      name: data.business.name,
      legalName: data.business.legalName === data.business.name ? null : data.business.legalName,
      gstin: data.business.gstin,
      address: data.business.address,
    },
    party: data.party,
    period: `${dates.from} – ${dates.to}`,
    generatedOn: formatPrintDate(data.generatedOn),
    opening: balanceText(data.openingPaise),
    rows: data.entries.map((entry) => ({
      date: formatPrintDate(entry.entryOn),
      particulars: labels[`entry_${entry.entryType}`].text,
      reference: entry.referenceNumber,
      note: entry.note === entry.referenceNumber ? null : entry.note,
      debit: entry.amountPaise > 0 ? formatAmount(entry.amountPaise) : '',
      credit: entry.amountPaise < 0 ? formatAmount(-entry.amountPaise) : '',
      balance: balanceText(entry.balancePaise),
    })),
    totalDebit: formatAmount(data.debitsPaise),
    totalCredit: formatAmount(data.creditsPaise),
    closing: balanceText(data.closingPaise),
    ageingOn: dates.to,
    ageing: ageingRows,
    openItems: data.openItems.map((item) => ({
      reference:
        item.number ?? labels[`entry_${item.kind === 'opening' ? 'opening' : 'adjustment'}`].text,
      date: formatPrintDate(item.raisedOn),
      dueOn: formatPrintDate(item.dueOn),
      daysPastDue: item.daysPastDue > 0 ? String(item.daysPastDue) : '',
      amount: formatAmount(item.outstandingPaise),
    })),
  };
}

const SHARE_TEXTS: Readonly<
  Record<
    PrintLanguage,
    {
      due: string;
      advance: string;
      settled: string;
      dueNow: string;
      attached: string;
      linked: string;
    }
  >
> = {
  en: {
    due: 'Dear {name}, your statement from {business} for {from} to {to}: balance due {amount} as of {to}.',
    advance:
      'Dear {name}, your statement from {business} for {from} to {to}: you have {amount} paid in advance as of {to}.',
    settled:
      'Dear {name}, your statement from {business} for {from} to {to}: nothing is due as of {to}.',
    dueNow: ' Of this, {amount} is due now.',
    attached: ' The statement PDF is attached.',
    linked: ' View the statement: {url}',
  },
  hi: {
    due: 'नमस्ते {name}, {business} से {from} से {to} तक का आपका खाता विवरण: {to} को देय बकाया {amount} है।',
    advance:
      'नमस्ते {name}, {business} से {from} से {to} तक का आपका खाता विवरण: {to} को आपका अग्रिम जमा {amount} है।',
    settled:
      'नमस्ते {name}, {business} से {from} से {to} तक का आपका खाता विवरण: {to} को कोई बकाया नहीं है।',
    dueNow: ' इसमें से {amount} अभी देय है।',
    attached: ' खाता विवरण की PDF साथ में है।',
    linked: ' खाता विवरण देखें: {url}',
  },
  te: {
    due: 'నమస్తే {name}, {business} నుండి {from} నుండి {to} వరకు మీ ఖాతా వివరణ: {to} నాటికి చెల్లించాల్సిన బకాయి {amount}.',
    advance:
      'నమస్తే {name}, {business} నుండి {from} నుండి {to} వరకు మీ ఖాతా వివరణ: {to} నాటికి మీ ముందస్తు చెల్లింపు {amount}.',
    settled:
      'నమస్తే {name}, {business} నుండి {from} నుండి {to} వరకు మీ ఖాతా వివరణ: {to} నాటికి బకాయి ఏమీ లేదు.',
    dueNow: ' ఇందులో {amount} ఇప్పుడే చెల్లించాలి.',
    attached: ' ఖాతా వివరణ PDF జత చేశాం.',
    linked: ' ఖాతా వివరణ చూడండి: {url}',
  },
};

/**
 * The short WhatsApp message sent with the statement PDF, in the statement's language:
 * the balance on the last day and how much of it is due now. A wa.me link carries
 * text only, so it says the PDF is attached (by hand), or, given a stored statement
 * link (MVP 3 round 2a, spec §6.4), where to open it; given a payment link (round
 * 4a), where to pay by UPI.
 */
export function statementShareText(
  data: StatementData,
  language: PrintLanguage,
  linkUrl: string | null = null,
  payUrl: string | null = null,
): string {
  const texts = SHARE_TEXTS[language];
  const { ageing } = data;
  const params = {
    name: data.party.name,
    business: data.business.name,
    from: formatPrintDate(data.from),
    to: formatPrintDate(data.to),
    amount: formatINR(Math.abs(ageing.netPaise)),
  };
  const head =
    ageing.netPaise > 0 ? texts.due : ageing.netPaise < 0 ? texts.advance : texts.settled;
  const dueNow = ageing.outstandingPaise - ageing.buckets.not_due;
  const tail =
    ageing.netPaise > 0 && dueNow > 0 ? fillLabel(texts.dueNow, { amount: formatINR(dueNow) }) : '';
  const attachment = linkUrl === null ? texts.attached : fillLabel(texts.linked, { url: linkUrl });
  return `${fillLabel(head, params)}${tail}${attachment}${payLinkText(payUrl, language)}`;
}

/** "Statement-Deccan-Contractors-2026-04-01-2026-10-11.pdf" (ASCII only, for every browser). */
export function statementFileName(data: StatementData): string {
  const name = data.party.name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return ['Statement', name, data.from, data.to].filter((part) => part !== '').join('-') + '.pdf';
}
