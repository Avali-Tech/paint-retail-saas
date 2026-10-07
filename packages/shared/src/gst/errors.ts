/** Why a GST calculation was refused. Each code names one rule the input broke. */
export type GstErrorCode =
  | 'invalid_amount'
  | 'invalid_quantity'
  | 'invalid_discount'
  | 'discount_exceeds_value'
  | 'invalid_date'
  | 'invalid_rate'
  | 'no_rate'
  | 'overlapping_rates'
  | 'invalid_state_code'
  | 'invalid_gstin'
  | 'composition_inter_state'
  | 'invalid_return'
  | 'unsupported_rounding';

/** Thrown for input the engine will not tax; `code` is stable for callers to branch on. */
export class GstError extends Error {
  override readonly name = 'GstError';

  constructor(
    readonly code: GstErrorCode,
    message: string,
  ) {
    super(message);
  }
}
