import { isGstStateCode } from '../gst/states.js';
import { supplyTypeFor } from '../gst/place-of-supply.js';
import { isValidGstin } from '../tax-ids.js';
import type { TallyProblem, TallyProblemCode } from './errors.js';
import type { TallyAllocation, TallyParty, TallyPeriod, TallyTaxLine } from './types.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written `YYYY-MM-DD`. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

const isPaise = (value: number) => Number.isSafeInteger(value) && value >= 0;

const lineTax = (line: TallyTaxLine) =>
  line.cgstPaise + line.sgstPaise + line.igstPaise + line.cessPaise;

/**
 * Checks the documents of a period against the input contract, so a voucher can
 * only be built from data that balances. Returns every problem found.
 */
export function checkPeriod(period: TallyPeriod): TallyProblem[] {
  const problems: TallyProblem[] = [];
  const add = (code: TallyProblemCode, document: string | null, message: string) => {
    problems.push({ code, document, message });
  };

  if (!isIsoDate(period.from) || !isIsoDate(period.to) || period.from > period.to) {
    add('invalid_period', null, `The period ${period.from} to ${period.to} is not a date range`);
    return problems;
  }
  if (period.companyName.trim() === '') {
    add('invalid_period', null, 'The Tally company name is blank');
  }

  const checkDate = (number: string, date: string) => {
    if (!isIsoDate(date) || date < period.from || date > period.to) {
      add(
        'out_of_period',
        number,
        `${number} is dated ${date}, outside ${period.from} to ${period.to}`,
      );
    }
  };
  const checkParty = (number: string, party: TallyParty) => {
    if (party.gstin !== null && !isValidGstin(party.gstin)) {
      add('tax_mismatch', number, `${number}: party GSTIN "${party.gstin}" is not valid`);
    }
    if (party.stateCode !== null && !isGstStateCode(party.stateCode)) {
      add('tax_mismatch', number, `${number}: party state code "${party.stateCode}" is unknown`);
    }
  };
  const checkAllocations = (
    number: string,
    allocations: readonly TallyAllocation[],
    limit: number,
  ) => {
    if (
      allocations.some(
        (allocation) => !isPaise(allocation.amountPaise) || allocation.amountPaise === 0,
      )
    ) {
      add(
        'invalid_amount',
        number,
        `${number}: every allocation must be a positive amount of paise`,
      );
      return;
    }
    const allocated = allocations.reduce((sum, allocation) => sum + allocation.amountPaise, 0);
    if (allocated > limit) {
      add(
        'over_allocated',
        number,
        `${number}: allocates ${String(allocated)} paise of ${String(limit)}`,
      );
    }
  };

  const seen = new Set<string>();
  const checkUnique = (key: string, number: string) => {
    if (seen.has(key)) add('duplicate_number', number, `${number} appears more than once`);
    seen.add(key);
  };

  for (const doc of period.documents) {
    const n = doc.number;
    checkUnique(`${doc.kind}|${doc.supplierGstin}|${n}`, n);
    checkDate(n, doc.issuedOn);
    checkParty(n, doc.party);
    if (!isGstStateCode(doc.supplierStateCode) || !isGstStateCode(doc.placeOfSupplyCode)) {
      add('tax_mismatch', n, `${n}: supplier state or place of supply is not a GST state code`);
      continue;
    }
    const amounts = doc.lines.flatMap((line) => [
      line.taxablePaise,
      line.cgstPaise,
      line.sgstPaise,
      line.igstPaise,
      line.cessPaise,
      line.rateBasisPoints,
      line.cessBasisPoints,
    ]);
    if (
      !amounts.every(isPaise) ||
      !isPaise(doc.totalPaise) ||
      !Number.isSafeInteger(doc.roundOffPaise) ||
      doc.roundOffPaise < -49 ||
      doc.roundOffPaise > 50
    ) {
      add('invalid_amount', n, `${n}: amounts must be whole paise and round-off within −49 to +50`);
      continue;
    }
    const computed = doc.lines.reduce((sum, line) => sum + line.taxablePaise + lineTax(line), 0);
    if (computed + doc.roundOffPaise !== doc.totalPaise) {
      add(
        'totals_mismatch',
        n,
        `${n}: lines and round-off add up to ${String(computed + doc.roundOffPaise)} paise, not the total ${String(doc.totalPaise)}`,
      );
    }
    if (supplyTypeFor(doc.supplierStateCode, doc.placeOfSupplyCode) !== doc.supplyType) {
      add(
        'tax_mismatch',
        n,
        `${n}: supply type ${doc.supplyType} does not match the place of supply`,
      );
    }
    const intra = doc.supplyType === 'intra_state';
    for (const line of doc.lines) {
      const wrongHead = intra ? line.igstPaise !== 0 : line.cgstPaise + line.sgstPaise !== 0;
      const untaxed = doc.kind === 'bill_of_supply' || line.nature !== 'taxable';
      if (wrongHead || (untaxed && (lineTax(line) !== 0 || line.rateBasisPoints !== 0))) {
        add(
          'tax_mismatch',
          n,
          `${n}: HSN ${line.hsnCode} carries tax that a ${doc.supplyType} ${doc.kind} at ${line.nature} cannot`,
        );
      }
    }
    const note = doc.kind === 'credit_note' || doc.kind === 'debit_note';
    if (note && doc.originals.length === 0) {
      add('missing_original', n, `${n}: a ${doc.kind} must name the invoice it adjusts`);
    }
    checkAllocations(n, doc.allocations, doc.totalPaise);
  }

  for (const receipt of period.receipts) {
    const n = receipt.number;
    checkUnique(`receipt|${n}`, n);
    checkDate(n, receipt.receivedOn);
    checkParty(n, receipt.party);
    if (!isPaise(receipt.amountPaise) || receipt.amountPaise === 0) {
      add('invalid_amount', n, `${n}: the amount must be a positive amount of paise`);
      continue;
    }
    checkAllocations(n, receipt.allocations, receipt.amountPaise);
  }

  const checkReceiptRef = (number: string, received: string, after: string) => {
    if (!isIsoDate(received) || received > after) {
      add(
        'out_of_period',
        number,
        `${number}: its receipt is dated ${received}, not on or before ${after}`,
      );
    }
  };

  for (const refund of period.refunds) {
    const n = refund.number;
    checkUnique(`refund|${n}`, n);
    checkDate(n, refund.paidOn);
    checkParty(n, refund.party);
    checkReceiptRef(n, refund.receipt.receivedOn, refund.paidOn);
    if (!isPaise(refund.amountPaise) || refund.amountPaise === 0) {
      add('invalid_amount', n, `${n}: the amount must be a positive amount of paise`);
    }
  }

  for (const bounce of period.bounces) {
    const n = `${bounce.receipt.number} (bounced)`;
    checkUnique(`bounce|${bounce.paymentId}`, n);
    checkDate(n, bounce.bouncedOn);
    checkParty(n, bounce.party);
    checkReceiptRef(n, bounce.receipt.receivedOn, bounce.bouncedOn);
    if (!isPaise(bounce.amountPaise) || bounce.amountPaise === 0 || !isPaise(bounce.chargePaise)) {
      add(
        'invalid_amount',
        n,
        `${n}: the amount must be a positive amount of paise and the charge whole paise`,
      );
      continue;
    }
    checkAllocations(n, bounce.reopened, bounce.amountPaise);
  }
  return problems;
}
