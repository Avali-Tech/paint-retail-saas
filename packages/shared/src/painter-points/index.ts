/**
 * Painter points from invoices (roadmap P2-M36): a pure engine for what an
 * invoice earns the painter tagged on it and what its credit notes take back.
 * No IO: the API loads the rules and lines and posts the ledger entries.
 */
export {
  EARN_BASES,
  MICRO_POINTS,
  MULTIPLIER_ONE_BPS,
  assertEarnRule,
  bestRuleFor,
  earnInvoice,
  lineMicroPoints,
  lineMillilitres,
  type EarnBasis,
  type EarnLine,
  type EarnRule,
  type InvoiceEarning,
  type LineEarning,
} from './earn.js';
export {
  pointsToTakeBack,
  reversalTarget,
  weighLines,
  type CreditedLine,
  type WeightedLine,
} from './reversal.js';
