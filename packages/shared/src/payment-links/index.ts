/**
 * UPI payment links (roadmap P2-M32, payment-link half): the rules and the API shapes.
 * No IO: the API creates links and records their payments; the web app asks for and
 * shows them.
 */
export {
  PAYMENT_LINK_MANAGE_PERMISSION,
  PAYMENT_LINK_READ_PERMISSION,
  type CreatePaymentLinkRequest,
  type LogCheckoutView,
  type LogPaymentRequest,
  type LogWebhook,
  type PaymentLinkCreated,
  type PaymentLinkDocumentView,
  type PaymentLinkPage,
  type PaymentLinkPaymentView,
  type PaymentLinkSettings,
  type PaymentLinkSummary,
  type PaymentLinkView,
} from './api.js';
export {
  DEFAULT_PAYMENT_LINK_DAYS,
  MAX_PAYMENT_LINK_PAISE,
  PAYMENT_LINK_ORIGINS,
  PAYMENT_LINK_PURPOSES,
  PAYMENT_LINK_STATUSES,
  STAFF_LINK_PURPOSES,
  allocateLinkPayment,
  linkStatusAt,
  nextLinkState,
  planPaymentLink,
  type LinkAllocation,
  type LinkEventKind,
  type LinkPlan,
  type LinkPlanInput,
  type LinkPlanProblem,
  type LinkState,
  type LinkTarget,
  type PaymentLinkOrigin,
  type PaymentLinkPurpose,
  type PaymentLinkStatus,
  type StaffLinkPurpose,
} from './rules.js';
