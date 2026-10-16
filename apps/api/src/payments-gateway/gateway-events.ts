import { schema, type Database, type Transaction } from '@paint/db';
import { and, eq } from 'drizzle-orm';
import type { VerifiedGatewayEvent, WebhookVerifier } from './payment-gateway.js';

const { paymentGatewayEvents } = schema;

/** What became of a webhook: null when its signature was bad. */
export type WebhookOutcome = 'applied' | 'duplicate' | 'ignored';

/** What the caller's `apply` is given besides the event. */
export interface GatewayEventContext {
  /** Records which business the event turned out to be about. */
  attach(organizationId: string): Promise<void>;
}

/**
 * Receives one webhook: checks its signature against the raw body before anything
 * in it is believed, stores the event (platform scope) and applies it in the same
 * transaction, once: a redelivered event is a `duplicate` and changes nothing, and
 * if applying fails the event is not stored, so the gateway's retry applies it.
 * `objectId` names what the event is about (a subscription, a payment link).
 */
export async function receiveGatewayWebhook<E extends VerifiedGatewayEvent>(
  db: Database,
  verifier: WebhookVerifier<E>,
  webhook: { readonly rawBody: Buffer; readonly headers: Readonly<Record<string, unknown>> },
  handler: {
    readonly objectId: (event: E) => string | null;
    readonly apply: (
      tx: Transaction,
      event: E,
      context: GatewayEventContext,
    ) => Promise<'applied' | 'ignored'>;
  },
): Promise<{ readonly event: E; readonly outcome: WebhookOutcome } | null> {
  const event = verifier.verifyWebhook(webhook.rawBody, webhook.headers);
  if (event === null) return null;
  const gateway = verifier.name;
  const outcome = await db.transaction(async (tx): Promise<WebhookOutcome> => {
    const recorded = await tx
      .insert(paymentGatewayEvents)
      .values({
        gateway,
        eventId: event.id,
        type: event.gatewayType,
        objectId: handler.objectId(event),
      })
      .onConflictDoNothing()
      .returning({ eventId: paymentGatewayEvents.eventId });
    if (recorded.length === 0) return 'duplicate';
    return handler.apply(tx, event, {
      attach: async (organizationId) => {
        await tx
          .update(paymentGatewayEvents)
          .set({ organizationId })
          .where(
            and(
              eq(paymentGatewayEvents.gateway, gateway),
              eq(paymentGatewayEvents.eventId, event.id),
            ),
          );
      },
    });
  });
  return { event, outcome };
}
