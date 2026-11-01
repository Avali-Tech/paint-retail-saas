import 'reflect-metadata';
import { Inject, Injectable } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import type { Permission } from '@paint/shared';
import { and, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { holdsPermission } from '../members/member-permission.js';
import type { NotificationEvent } from './events.js';

const {
  emailOutbox,
  memberStores,
  notificationPreferences,
  notifications,
  organizationMembers,
  roles,
  users,
} = schema;

/** Settings the notifier needs: where links point, and whether email is on. */
export const NOTIFIER_SETTINGS = Symbol('NOTIFIER_SETTINGS');
export interface NotifierSettings {
  readonly appUrl: string;
  readonly emailEnabled: boolean;
}

export interface Notice {
  readonly organizationId: string;
  readonly event: NotificationEvent;
  /**
   * Everyone with the permission (or any of several) at the store (null =
   * anywhere), or particular members…
   */
  readonly to:
    | {
        readonly storeId: string | null;
        readonly permission: Permission | readonly Permission[];
      }
    | { readonly memberIds: readonly string[] }
    /** …or everyone with a role (the Owner, for an owner-level credit approval). */
    | { readonly roleKey: string };
  /** …except the person who caused it. */
  readonly actorMemberId?: string;
  readonly title: string;
  readonly body: string;
  /** Path in the web app, e.g. /transfers/<id>. */
  readonly link: string;
}

/**
 * Tells the right people about an event, inside the caller's transaction, so a
 * notification exists exactly when the event does. Emails go to the outbox and
 * are sent afterwards by the worker.
 */
@Injectable()
export class Notifier {
  constructor(@Inject(NOTIFIER_SETTINGS) private readonly settings: NotifierSettings) {}

  /** Returns how many members were told. */
  async notify(tx: Transaction, notice: Notice): Promise<number> {
    const recipients = await tx
      .select({
        memberId: organizationMembers.id,
        email: users.email,
        inApp: sql<boolean>`coalesce(${notificationPreferences.inApp}, true)`,
        byEmail: sql<boolean>`coalesce(${notificationPreferences.email}, true)`,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(
        notificationPreferences,
        and(
          eq(notificationPreferences.memberId, organizationMembers.id),
          eq(notificationPreferences.event, notice.event),
        ),
      )
      .where(
        and(
          // Explicit, not only via row-level security: the background worker
          // runs outside any one business.
          eq(organizationMembers.organizationId, notice.organizationId),
          eq(organizationMembers.isActive, true),
          notice.actorMemberId ? ne(organizationMembers.id, notice.actorMemberId) : undefined,
          this.audience(tx, notice.to),
        ),
      );

    const inApp = recipients.filter((recipient) => recipient.inApp);
    if (inApp.length > 0) {
      await tx.insert(notifications).values(
        inApp.map(({ memberId }) => ({
          organizationId: notice.organizationId,
          memberId,
          event: notice.event,
          title: notice.title,
          body: notice.body,
          link: notice.link,
        })),
      );
    }
    const byEmail = this.settings.emailEnabled
      ? recipients.flatMap(({ memberId, email, byEmail: wanted }) =>
          wanted && email ? [{ memberId, email }] : [],
        )
      : [];
    if (byEmail.length > 0) {
      await tx.insert(emailOutbox).values(
        byEmail.map(({ memberId, email }) => ({
          organizationId: notice.organizationId,
          memberId,
          event: notice.event,
          toAddress: email,
          subject: notice.title,
          textBody: [
            notice.body,
            '',
            `Open it: ${this.settings.appUrl}${notice.link}`,
            '',
            'You can choose which emails you get under Settings → Notifications.',
          ].join('\n'),
        })),
      );
    }
    return recipients.length;
  }

  private audience(tx: Transaction, to: Notice['to']): SQL | undefined {
    if ('memberIds' in to) return inArray(organizationMembers.id, [...to.memberIds]);
    if ('roleKey' in to) {
      return inArray(
        organizationMembers.roleId,
        tx.select({ id: roles.id }).from(roles).where(eq(roles.key, to.roleKey)),
      );
    }
    const permissions = typeof to.permission === 'string' ? [to.permission] : to.permission;
    return and(
      or(...permissions.map((permission) => holdsPermission(tx, permission))),
      to.storeId === null
        ? undefined
        : or(
            eq(organizationMembers.allStores, true),
            inArray(
              organizationMembers.id,
              tx
                .select({ memberId: memberStores.memberId })
                .from(memberStores)
                .where(eq(memberStores.storeId, to.storeId)),
            ),
          ),
    );
  }
}
