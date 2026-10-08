import {
  MAX_SALES_LINES,
  SALES_NOTE_MAX_LENGTH,
  type Discount,
  type PaymentTerms,
  type QuotationRequest,
  type QuotationView,
  type SalesLineView,
  type SalesOrderRequest,
  type SalesOrderView,
} from '@paint/shared';
import { newBill, type Bill, type BillAction, type BillLine } from '../pos/bill.js';
import type { LineKey } from '../pos/ScanBox.js';

// The quotation and order editor's header, apart from its lines (the lines are the
// counter's bill, pos/bill.ts, so the grid works the same as at the POS).

/** A party chosen in the editor. */
export interface ChosenParty {
  readonly id: string;
  readonly name: string;
}

export interface SalesHeader {
  readonly storeId: string;
  readonly billTo: ChosenParty | null;
  readonly influencer: ChosenParty | null;
  /** The site (a project); "" for none. */
  readonly projectId: string;
  readonly shipToName: string;
  readonly shipToAddress: string;
  readonly shipToState: string;
  /** Quotations only; "" for the business's default validity. */
  readonly validUntil: string;
  /** Orders only. */
  readonly paymentTerms: PaymentTerms;
  readonly note: string;
}

export const EMPTY_HEADER: SalesHeader = {
  storeId: '',
  billTo: null,
  influencer: null,
  projectId: '',
  shipToName: '',
  shipToAddress: '',
  shipToState: '',
  validUntil: '',
  paymentTerms: 'postpaid',
  note: '',
};

/** Party roles that may be named as the influencer (spec §6.4). */
export const INFLUENCER_ROLES = ['painter', 'contractor', 'architect'] as const;

export type HeaderField = 'storeId' | 'billTo' | 'validUntil' | 'shipToState' | 'note' | 'lines';
export type HeaderProblem =
  'required' | 'pastDate' | 'shipToState' | 'noteLong' | 'noLines' | 'tooManyLines';
export type Problems = Partial<Record<HeaderField, HeaderProblem>>;

/** What stops the document from being saved; empty when it may be. */
export function problemsOf(
  header: SalesHeader,
  lines: readonly BillLine[],
  today: string,
  kind: 'quotation' | 'order',
): Problems {
  const problems: Problems = {};
  if (header.storeId === '') problems.storeId = 'required';
  if (header.billTo === null) problems.billTo = 'required';
  if (kind === 'quotation' && header.validUntil !== '' && header.validUntil < today) {
    problems.validUntil = 'pastDate';
  }
  const shipTyped = header.shipToName.trim() !== '' || header.shipToAddress.trim() !== '';
  if (shipTyped && header.shipToState === '') problems.shipToState = 'shipToState';
  if (header.note.trim().length > SALES_NOTE_MAX_LENGTH) problems.note = 'noteLong';
  if (lines.length === 0) problems.lines = 'noLines';
  else if (lines.length > MAX_SALES_LINES) problems.lines = 'tooManyLines';
  return problems;
}

const text = (value: string) => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const defined = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

function commonRequest(header: SalesHeader, lines: readonly BillLine[]) {
  return defined({
    storeId: header.storeId,
    billToPartyId: String(header.billTo?.id),
    influencerPartyId: header.influencer?.id,
    projectId: text(header.projectId),
    shipTo:
      header.shipToState === ''
        ? undefined
        : defined({
            name: text(header.shipToName),
            address: text(header.shipToAddress),
            stateCode: header.shipToState,
          }),
    note: text(header.note),
    lines: lines.map((line) =>
      defined({
        variantId: line.variantId,
        quantity: line.quantity,
        unitPricePaise: line.unitPricePaise,
        discount: line.discount ?? undefined,
      }),
    ),
  });
}

/** The body of POST /quotations or PUT /quotations/:id (checked by problemsOf first). */
export function quotationRequest(
  header: SalesHeader,
  lines: readonly BillLine[],
): QuotationRequest {
  return { ...commonRequest(header, lines), ...defined({ validUntil: text(header.validUntil) }) };
}

/** The body of POST /sales-orders or PUT /sales-orders/:id (checked by problemsOf first). */
export function orderRequest(header: SalesHeader, lines: readonly BillLine[]): SalesOrderRequest {
  return { ...commonRequest(header, lines), paymentTerms: header.paymentTerms };
}

const discountOf = (line: SalesLineView): Discount | null => {
  if (line.discountBps !== null) return { kind: 'percent', basisPoints: line.discountBps };
  return line.discountPaise === null ? null : { kind: 'amount', paise: line.discountPaise };
};

/** A saved line back on the grid. */
export const lineFromView = (line: SalesLineView): BillLine => ({
  variantId: line.variantId,
  sku: line.sku,
  name: line.description,
  taxCategoryId: null,
  unitPricePaise: line.unitPricePaise,
  quantity: line.quantity,
  discount: discountOf(line),
});

/** A saved draft quotation or order, ready to edit. */
export function editorStateOf(document: QuotationView | SalesOrderView | null): {
  header: SalesHeader;
  bill: Bill;
} {
  const bill = newBill('editor');
  if (document === null) return { header: EMPTY_HEADER, bill };
  return {
    header: {
      storeId: document.storeId,
      billTo: { id: document.billTo.id, name: document.billTo.name },
      influencer: document.influencer,
      projectId: document.project?.id ?? '',
      shipToName: document.shipTo.name ?? '',
      shipToAddress: document.shipTo.address ?? '',
      shipToState: document.shipTo.stateCode ?? '',
      validUntil: 'validUntil' in document ? document.validUntil : '',
      paymentTerms: 'paymentTerms' in document ? document.paymentTerms : 'postpaid',
      note: document.note ?? '',
    },
    bill: { ...bill, lines: document.lines.map(lineFromView) },
  };
}

/** What a key pressed in the empty scan box does to the bill, as at the counter. */
export function lineKeyAction(bill: Bill, key: LineKey): BillAction | null {
  const at = bill.selected;
  if (at === null) return null;
  if (key === 'more' || key === 'less') {
    return { type: 'step', index: at, by: key === 'more' ? 1 : -1 };
  }
  if (key === 'remove') return { type: 'remove', index: at };
  const next = at + (key === 'down' ? 1 : -1);
  return { type: 'select', index: Math.min(Math.max(next, 0), bill.lines.length - 1) };
}
