import type { Permission } from '../permissions.js';

/**
 * Brand statement reconciliation (roadmap P2-M34, MVP 3 round 6a; spec §6.3): a brand's
 * or distributor's statement imported with a template, matched against our GRNs and the
 * scheme money we recorded, and the mismatches listed. Money in paise; dates India-time
 * `YYYY-MM-DD`. Amounts on a statement are signed from the brand's books: positive is a
 * debit (the brand billed us), negative a credit (a credit note, our payment).
 */

/** Seeing statements: as seeing purchasing. */
export const BRAND_STATEMENT_READ_PERMISSION = 'purchasing:read' as const satisfies Permission;
/** Templates, imports and matching: whoever looks after brand money ([PO-90]). */
export const BRAND_STATEMENT_MANAGE_PERMISSION = 'schemes:manage' as const satisfies Permission;

export const STATEMENT_AMOUNT_MODES = ['debit_credit', 'signed'] as const;
export type StatementAmountMode = (typeof STATEMENT_AMOUNT_MODES)[number];

export const STATEMENT_SIGN_CONVENTIONS = ['debit_positive', 'credit_positive'] as const;
export type StatementSignConvention = (typeof STATEMENT_SIGN_CONVENTIONS)[number];

export const STATEMENT_DATE_FORMATS = [
  'dd-mm-yyyy',
  'mm-dd-yyyy',
  'yyyy-mm-dd',
  'dd-mon-yyyy',
] as const;
export type StatementDateFormat = (typeof STATEMENT_DATE_FORMATS)[number];

/** A GRN is compared at its value with GST (as the brand bills it), or before GST. */
export const STATEMENT_GRN_BASES = ['with_gst', 'taxable'] as const;
export type StatementGrnBasis = (typeof STATEMENT_GRN_BASES)[number];

export const STATEMENT_LINE_KINDS = [
  'opening',
  'invoice',
  'credit_note',
  'debit_note',
  'payment',
  'other',
] as const;
export type StatementLineKind = (typeof STATEMENT_LINE_KINDS)[number];

/** The kinds a template's type words can name; anything else is `other`. */
export const TYPED_LINE_KINDS = [
  'opening',
  'invoice',
  'credit_note',
  'debit_note',
  'payment',
] as const;
export type TypedLineKind = (typeof TYPED_LINE_KINDS)[number];
export type StatementTypeRules = Partial<Record<TypedLineKind, readonly string[]>>;

/**
 * Where a line stands: matched (amounts within the tolerance), partial (matched by
 * reference, amounts differ), unmatched, explained by a member, or untracked (our
 * payments to the brand: the app records none until P2-M17, [PO-92]).
 */
export const STATEMENT_LINE_STATUSES = [
  'matched',
  'partial',
  'unmatched',
  'explained',
  'untracked',
] as const;
export type StatementLineStatus = (typeof STATEMENT_LINE_STATUSES)[number];

/** Our side: a GRN of the statement's supplier, or scheme money recorded for its brand. */
export const OUR_RECORD_KINDS = ['grn', 'benefit_receipt'] as const;
export type OurRecordKind = (typeof OUR_RECORD_KINDS)[number];

export const MAX_STATEMENT_LINES = 5_000;
export const MAX_DATE_WINDOW_DAYS = 60;
/** ₹1,000: a larger tolerance would hide real differences. */
export const MAX_AMOUNT_TOLERANCE_PAISE = 1_00_000;
export const DEFAULT_DATE_WINDOW_DAYS = 7;
export const DEFAULT_AMOUNT_TOLERANCE_PAISE = 100;

/** How a statement file is laid out: what parsing needs from a template. */
export interface StatementLayout {
  readonly headerRowsToSkip: number;
  readonly dateColumn: string;
  readonly documentColumn: string;
  readonly typeColumn: string | null;
  readonly referenceColumn: string | null;
  readonly descriptionColumn: string | null;
  readonly amountMode: StatementAmountMode;
  readonly debitColumn: string | null;
  readonly creditColumn: string | null;
  readonly amountColumn: string | null;
  readonly signConvention: StatementSignConvention;
  readonly dateFormat: StatementDateFormat;
  readonly typeRules: StatementTypeRules;
}

/** How close a line and a record of ours must be to match. */
export interface StatementTolerance {
  readonly dateWindowDays: number;
  readonly amountTolerancePaise: number;
}

/** POST /brand-statements/templates and PUT …/:id. */
export interface StatementTemplateInput extends StatementLayout, StatementTolerance {
  readonly name: string;
  readonly supplierPartyId: string;
  readonly brandId: string | null;
  readonly grnAmountBasis: StatementGrnBasis;
  readonly isActive: boolean;
}

interface Named {
  readonly id: string;
  readonly name: string;
}

export interface StatementTemplateView extends StatementTemplateInput {
  readonly id: string;
  readonly supplier: Named;
  readonly brand: Named | null;
  readonly statements: number;
  readonly updatedAt: string;
}

/** A line read from a file, before it is stored. */
export interface ParsedStatementLine {
  readonly rowNumber: number;
  readonly lineDate: string;
  readonly kind: StatementLineKind;
  readonly documentNumber: string | null;
  readonly typeText: string | null;
  readonly reference: string | null;
  readonly description: string | null;
  readonly amountPaise: number;
}

export interface StatementRowProblem {
  /** Spreadsheet row (1 = the file's first row); 0 for the whole file. */
  readonly row: number;
  readonly column: string | null;
  readonly message: string;
}

/** POST /brand-statements/preview: what the file would import, storing nothing. */
export interface StatementPreview {
  readonly fileName: string;
  readonly valid: boolean;
  readonly lines: readonly ParsedStatementLine[];
  readonly errors: readonly StatementRowProblem[];
  /** Rows left out: blank, a total, or with no date or amount. */
  readonly skipped: readonly StatementRowProblem[];
  readonly periodFrom: string | null;
  readonly periodTo: string | null;
  /** From an opening line, when the statement has one. */
  readonly openingBalancePaise: number | null;
  readonly debitsPaise: number;
  readonly creditsPaise: number;
  /** An active statement of this supplier with the same file, if any. */
  readonly duplicateOf: string | null;
}

/** A GRN or scheme receipt of ours, as the reconciliation shows it. */
export interface OurRecordView {
  /** `grn:<id>` or `benefit_receipt:<id>`. */
  readonly key: string;
  readonly kind: OurRecordKind;
  readonly id: string;
  /** GRN-000012, or the scheme's name. */
  readonly number: string;
  /** The supplier invoice number, or the credit note's reference. */
  readonly reference: string | null;
  readonly date: string;
  /** Signed as a statement line would show it: a GRN positive, scheme money negative. */
  readonly amountPaise: number;
  readonly inPeriod: boolean;
  /** The line of this statement it settles, if any. */
  readonly lineId: string | null;
  /** Settles a line of another statement. */
  readonly elsewhere: boolean;
  readonly schemeId: string | null;
}

export interface StatementMatchView {
  readonly source: 'auto' | 'manual' | 'explained';
  readonly recordKey: string | null;
  /** Line amount − our amount. */
  readonly differencePaise: number | null;
  readonly note: string | null;
  readonly by: string | null;
}

export interface StatementLineView extends ParsedStatementLine {
  readonly id: string;
  readonly status: StatementLineStatus;
  readonly match: StatementMatchView | null;
  /** Records a member unmatched from this line: never proposed again. */
  readonly rejected: readonly string[];
}

/**
 * The period's figures. Brand − ours = differences + brand-only lines − our-only
 * records, exactly (`statementSummary`).
 */
export interface StatementSummary {
  readonly counts: Readonly<Record<StatementLineStatus, number>>;
  /** Σ the statement's lines, opening left out. */
  readonly brandMovementPaise: number;
  /** Σ our records it settles, plus ours in the period it does not. */
  readonly ourMovementPaise: number;
  readonly differencePaise: number;
  readonly amountDifferencesPaise: number;
  readonly unmatchedLinesPaise: number;
  readonly explainedLinesPaise: number;
  readonly untrackedLinesPaise: number;
  readonly ourUnmatchedPaise: number;
  readonly ourUnmatchedCount: number;
  readonly openingBalancePaise: number | null;
  /** Opening + movement, when the opening is known. */
  readonly brandClosingPaise: number | null;
  /** As printed on the statement, when entered. */
  readonly printedClosingPaise: number | null;
}

export const BRAND_STATEMENT_STATUSES = ['active', 'discarded'] as const;
export type BrandStatementStatus = (typeof BRAND_STATEMENT_STATUSES)[number];

export interface BrandStatementSummaryView {
  readonly id: string;
  readonly number: string;
  readonly template: Named;
  readonly supplier: Named;
  readonly brand: Named | null;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly status: BrandStatementStatus;
  readonly fileName: string;
  /** The scanned original is kept and can be downloaded. */
  readonly fileKept: boolean;
  readonly lines: number;
  /** Lines unmatched or partly matched. */
  readonly mismatches: number;
  readonly uploadedBy: string;
  readonly createdAt: string;
  /** When its lines were last matched. */
  readonly matchedAt: string;
}

/** GET /brand-statements/:id: the reconciliation screen. */
export interface BrandStatementDetail {
  readonly statement: BrandStatementSummaryView;
  readonly tolerance: StatementTolerance;
  readonly summary: StatementSummary;
  readonly lines: readonly StatementLineView[];
  readonly ours: readonly OurRecordView[];
}

/** POST /brand-statements/:id/lines/:lineId/match. */
export interface ManualMatchInput {
  readonly recordKey: string;
  readonly note: string | null;
}

/** POST /brand-statements/:id/lines/:lineId/explain. */
export interface ExplainLineInput {
  readonly note: string;
}

/** POST /brand-statements/:id/lines/:lineId/scheme-receipt: record and match in one step. */
export interface SchemeReceiptFromLineInput {
  readonly schemeId: string;
  readonly claimId: string | null;
  readonly note: string | null;
}

/** What a matching run changed. */
export interface MatchRunResult {
  readonly added: number;
  readonly removed: number;
  readonly detail: BrandStatementDetail;
}
