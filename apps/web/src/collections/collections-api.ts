import type {
  CreatePromiseBody,
  MessageChannel,
  MessageLanguage,
  MessageView,
  TemplateKey,
  TemplateView,
  MessagingStatus,
  PartyConsentsView,
  PromiseView,
  RecordConsentBody,
  ReminderScheduleInput,
  ReminderScheduleView,
  ShareStatementBody,
  StatementLinkView,
  StatementShareResult,
  WorklistPage,
} from '@paint/shared';
import type { ApiClient } from '../api/client.js';

// Collections, party messaging and stored statement links (apps/api/src/collections,
// apps/api/src/messaging, apps/api/src/statements). Shapes come from @paint/shared.

export interface WorklistFilters {
  /** A member's id, "me" or "none". */
  readonly salespersonId?: string | undefined;
  readonly storeId?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export function collectionsEndpoints(api: ApiClient) {
  return {
    worklist: (filters: WorklistFilters, signal?: AbortSignal) =>
      api.get<WorklistPage>('/collections/worklist', { query: { ...filters }, signal }),
    acknowledge: (escalationId: string, note?: string) =>
      api.post<undefined>(
        `/collections/escalations/${escalationId}/acknowledge`,
        note === undefined ? {} : { note },
      ),
    promises: (partyId: string, signal?: AbortSignal) =>
      api.get<PromiseView[]>(`/parties/${partyId}/promises`, { signal }),
    createPromise: (partyId: string, body: CreatePromiseBody) =>
      api.post<PromiseView>(`/parties/${partyId}/promises`, body),
    cancelPromise: (promiseId: string, reason: string) =>
      api.post<PromiseView>(`/promises/${promiseId}/cancel`, { reason }),
    reminderSchedules: (signal?: AbortSignal) =>
      api.get<ReminderScheduleView[]>('/collections/reminder-schedules', { signal }),
    saveReminderSchedules: (schedules: readonly ReminderScheduleInput[]) =>
      api.put<ReminderScheduleView[]>('/collections/reminder-schedules', { schedules }),
  };
}

/** PUT /message-templates: a template's new wording (WhatsApp: as the provider approved it). */
export interface TemplateSave {
  readonly key: TemplateKey;
  readonly channel: MessageChannel;
  readonly language: MessageLanguage;
  readonly body: string;
  readonly providerTemplateName: string | null;
}

export function messagingEndpoints(api: ApiClient) {
  return {
    status: (signal?: AbortSignal) => api.get<MessagingStatus>('/messaging/status', { signal }),
    consents: (partyId: string, signal?: AbortSignal) =>
      api.get<PartyConsentsView>(`/parties/${partyId}/consents`, { signal }),
    recordConsent: (partyId: string, body: RecordConsentBody) =>
      api.post<PartyConsentsView>(`/parties/${partyId}/consents`, body),
    messages: (partyId: string, signal?: AbortSignal) =>
      api.get<MessageView[]>(`/parties/${partyId}/messages`, { query: { limit: 10 }, signal }),
    shareStatement: (partyId: string, body: ShareStatementBody) =>
      api.post<StatementShareResult>(`/parties/${partyId}/statement/links`, body),
    statementLinks: (partyId: string, signal?: AbortSignal) =>
      api.get<StatementLinkView[]>(`/parties/${partyId}/statement/links`, { signal }),
    revokeStatementLink: (linkId: string) =>
      api.post<StatementLinkView>(`/statement-links/${linkId}/revoke`),
    /** Every template in every channel and language, as the business sends it. */
    templates: (signal?: AbortSignal) => api.get<TemplateView[]>('/message-templates', { signal }),
    /** Rewords one template; answers them all. */
    saveTemplate: (body: TemplateSave) => api.put<TemplateView[]>('/message-templates', body),
    /** Goes back to the product's wording for one template; answers them all. */
    resetTemplate: (key: TemplateKey, channel: MessageChannel, language: MessageLanguage) =>
      api.delete<TemplateView[]>(`/message-templates/${key}/${channel}/${language}`),
  };
}
