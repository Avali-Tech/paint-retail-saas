/**
 * Messages to parties (roadmap P2-M32, messaging half): templates, consent and the
 * API shapes. No IO: the API queues and sends, the web app shows and records.
 */
export {
  CONSENT_MANAGE_PERMISSION,
  MESSAGE_STATUSES,
  MESSAGING_READ_PERMISSION,
  TEMPLATES_MANAGE_PERMISSION,
  type ConsentView,
  type MessageStatus,
  type MessageView,
  type MessagingStatus,
  type PartyConsentsView,
  type QueueResult,
  type RecordConsentBody,
  type TemplateView,
} from './api.js';
export {
  CONSENT_METHODS,
  CONSENT_NOTICE_VERSION,
  CONSENT_STATES,
  STAFF_CONSENT_METHODS,
  consentFor,
  consentNotice,
  type ConsentMethod,
  type ConsentRecord,
  type ConsentState,
} from './consent.js';
export {
  DEFAULT_TEMPLATES,
  MESSAGE_CHANNELS,
  MESSAGE_LANGUAGES,
  TEMPLATE_KEYS,
  TEMPLATE_MAX_LENGTH,
  TEMPLATE_VARIABLES,
  emailParts,
  renderTemplate,
  templateProblems,
  variablesIn,
  type MessageChannel,
  type MessageLanguage,
  type TemplateKey,
} from './templates.js';
