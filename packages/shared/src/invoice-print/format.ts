import { gstState } from '../gst/states.js';
import type { TaxNature } from '../gst/types.js';
import { paiseToRupees } from '../money.js';
import type { PrintAddress } from './types.js';

const amountFormatter = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const quantityFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });

/** Paise as rupees with Indian grouping and no sign: 1234550 -> "12,345.50". */
export function formatAmount(paise: number): string {
  return amountFormatter.format(paiseToRupees(paise) as Intl.StringNumericLiteral);
}

/** Thousandths of a unit as a quantity: 2500 -> "2.5", 1000000 -> "1,000". */
export function formatQuantity(milli: number): string {
  const whole = Math.trunc(milli / 1000);
  const fraction = String(milli % 1000).padStart(3, '0');
  return quantityFormatter.format(`${String(whole)}.${fraction}` as Intl.StringNumericLiteral);
}

const NATURE_RATES: Readonly<Record<Exclude<TaxNature, 'taxable'>, string>> = {
  nil_rated: 'Nil rated',
  exempt: 'Exempt',
  non_gst: 'Non-GST',
};

/** A line's GST rate: "18%", "2.5%"; nil-rated, exempt and non-GST lines say so. */
export function formatRate(nature: TaxNature, basisPoints: number): string {
  return nature === 'taxable' ? `${String(basisPoints / 100)}%` : NATURE_RATES[nature];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-07" -> "07 Oct 2026": unambiguous on paper, whatever the reader's habit. */
export function formatPrintDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const month = MONTHS[Number(match?.[2]) - 1];
  if (!match || month === undefined) throw new RangeError(`Invalid date "${iso}"`);
  return `${String(match[3])} ${month} ${String(match[1])}`;
}

/** "Telangana (36)": the state name with its GST code, as Rule 46(e) and (n) ask. */
export function stateLabel(code: string): string {
  return `${gstState(code).name} (${code})`;
}

/** Street lines, then "City 500016"; empty parts left out. The state is printed on its own line. */
export function addressLines(address: PrintAddress): string[] {
  const place = [address.city, address.pincode].filter((part) => part !== null).join(' ');
  return [...address.lines, place].filter((line) => line.trim() !== '');
}
