import { checkPaise } from './arith.js';

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 1–99 in words, hyphenating compound tens: "Twenty-Three". */
function belowHundred(n: number): string {
  if (n < 20) return String(ONES[n]);
  const ones = n % 10;
  const tens = String(TENS[Math.trunc(n / 10)]);
  return ones === 0 ? tens : `${tens}-${String(ONES[ones])}`;
}

/** 1–999 in words, without "and": "Four Hundred Fifty-Six". */
function belowThousand(n: number): string {
  const hundreds = Math.trunc(n / 100);
  const rest = n % 100;
  const parts = hundreds > 0 ? [`${belowHundred(hundreds)} Hundred`] : [];
  if (rest > 0) parts.push(belowHundred(rest));
  return parts.join(' ');
}

/**
 * A whole number in the Indian system: thousand, lakh (1,00,000) and crore
 * (1,00,00,000). From a hundred crore up, the crores are themselves counted in
 * lakh and thousand: 1,23,45,67,89,012 is "Twelve Thousand Three Hundred
 * Forty-Five Crore Sixty-Seven Lakh Eighty-Nine Thousand Twelve".
 */
function indianWords(n: number): string {
  const crore = Math.trunc(n / 10_000_000);
  const lakh = Math.trunc(n / 100_000) % 100;
  const thousand = Math.trunc(n / 1000) % 100;
  const rest = n % 1000;
  const parts: string[] = [];
  if (crore > 0) parts.push(`${indianWords(crore)} Crore`);
  if (lakh > 0) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest > 0) parts.push(belowThousand(rest));
  return parts.join(' ');
}

/**
 * An amount in words for an invoice, in Indian numbering:
 * 1,23,456.78 is "Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six
 * and Seventy-Eight Paise Only". Zero is "Rupees Zero Only"; under a rupee,
 * "Fifty Paise Only".
 */
export function amountInWords(paise: number): string {
  const amount = Number(checkPaise(paise, 'Amount'));
  const rupees = Math.trunc(amount / 100);
  const fraction = amount % 100;
  const paiseWords = fraction > 0 ? `${belowHundred(fraction)} Paise` : '';
  if (rupees === 0) return fraction > 0 ? `${paiseWords} Only` : 'Rupees Zero Only';
  const rupeeWords = `Rupees ${indianWords(rupees)}`;
  return fraction > 0 ? `${rupeeWords} and ${paiseWords} Only` : `${rupeeWords} Only`;
}
