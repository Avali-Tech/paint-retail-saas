import 'reflect-metadata';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection } from '@paint/db';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { EVENT_TITLES, NOTIFICATION_EVENTS, type NotificationEvent } from './events.js';
import type { ListNotificationsQuery, PreferencesInput } from './notifications.schemas.js';

const { notificationPreferences, notifications } = schema;

export interface NotificationView {
  readonly id: string;
  readonly event: NotificationEvent;
  readonly title: string;
  readonly body: string;
  readonly link: string;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export interface NotificationPage {
  readonly items: NotificationView[];
  readonly total: number;
  /** Unread notifications in all, for the badge. */
  readonly unread: number;
}

export interface PreferenceView {
  readonly event: NotificationEvent;
  readonly title: string;
  readonly inApp: boolean;
  readonly email: boolean;
}

/** A member's own notifications and preferences. */
@Injectable()
export class NotificationsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  list(auth: AuthContext, query: ListNotificationsQuery): Promise<NotificationPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const mine = eq(notifications.memberId, auth.memberId);
      const where = and(mine, query.unread ? isNull(notifications.readAt) : undefined);
      const rows = await tx
        .select()
        .from(notifications)
        .where(where)
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx
        .select({
          total: count(),
          unread: sql<number>`(select count(*)::int from ${notifications} where ${mine} and ${notifications.readAt} is null)`,
        })
        .from(notifications)
        .where(where);
      return {
        items: rows.map((row) => ({
          id: row.id,
          event: row.event,
          title: row.title,
          body: row.body,
          link: row.link,
          createdAt: row.createdAt.toISOString(),
          readAt: row.readAt ? row.readAt.toISOString() : null,
        })),
        total: Number(totals?.total),
        unread: Number(totals?.unread),
      };
    });
  }

  markRead(auth: AuthContext, notificationId: string): Promise<void> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const found = await tx
        .update(notifications)
        .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
        .where(and(eq(notifications.id, notificationId), eq(notifications.memberId, auth.memberId)))
        .returning({ id: notifications.id });
      if (found.length === 0) throw new NotFoundException('Notification not found');
    });
  }

  markAllRead(auth: AuthContext): Promise<{ marked: number }> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const marked = await tx
        .update(notifications)
        .set({ readAt: sql`now()` })
        .where(and(eq(notifications.memberId, auth.memberId), isNull(notifications.readAt)))
        .returning({ id: notifications.id });
      return { marked: marked.length };
    });
  }

  preferences(auth: AuthContext): Promise<PreferenceView[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const saved = new Map(
        (
          await tx
            .select()
            .from(notificationPreferences)
            .where(eq(notificationPreferences.memberId, auth.memberId))
        ).map((row) => [row.event, row]),
      );
      return NOTIFICATION_EVENTS.map((event) => {
        const preference = saved.get(event);
        return {
          event,
          title: EVENT_TITLES[event],
          inApp: preference ? preference.inApp : true,
          email: preference ? preference.email : true,
        };
      });
    });
  }

  async savePreferences(auth: AuthContext, input: PreferencesInput): Promise<PreferenceView[]> {
    await withTenant(this.connection.db, auth.organization.id, async (tx) => {
      for (const { event, inApp, email } of input.preferences) {
        await tx
          .insert(notificationPreferences)
          .values({
            organizationId: auth.organization.id,
            memberId: auth.memberId,
            event,
            inApp,
            email,
          })
          .onConflictDoUpdate({
            target: [notificationPreferences.memberId, notificationPreferences.event],
            set: { inApp, email, updatedAt: sql`now()` },
          });
      }
    });
    return this.preferences(auth);
  }
}
