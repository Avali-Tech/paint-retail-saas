/** Why a Tally export was refused. Each code names one rule the input broke. */
export type TallyProblemCode =
  | 'invalid_period'
  | 'out_of_period'
  | 'invalid_amount'
  | 'totals_mismatch'
  | 'tax_mismatch'
  | 'missing_original'
  | 'over_allocated'
  | 'duplicate_number'
  | 'unmapped_ledger'
  | 'invalid_ledger_name'
  | 'ledger_conflict';

/** One thing wrong with an export; `document` is our document or receipt number, if any. */
export interface TallyProblem {
  readonly code: TallyProblemCode;
  readonly document: string | null;
  readonly message: string;
}

/**
 * Thrown when an export cannot be built. It carries every problem found, not
 * just the first, so a settings screen can list all the ledgers still to map.
 */
export class TallyError extends Error {
  override readonly name = 'TallyError';

  constructor(readonly problems: readonly TallyProblem[]) {
    super(
      [
        `The Tally export has ${String(problems.length)} problem(s):`,
        ...problems.map((problem) => `- ${problem.message}`),
      ].join('\n'),
    );
  }
}
