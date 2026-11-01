import 'reflect-metadata';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection } from '@paint/db';
import {
  INBOX_GROUP_LIMIT,
  can,
  canAccessStore,
  variantTitle,
  type InboxAction,
  type InboxCount,
  type InboxGroup,
  type InboxItem,
  type InboxKind,
  type InboxView,
} from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { RECORD_PATHS } from '../activities/activity-records.js';
import { ActivitiesService } from '../activities/activities.service.js';
import { CollectionsService } from '../collections/collections.service.js';
import { CreditApprovalsService } from '../credit/credit-approvals.service.js';
import { CreditService } from '../credit/credit.service.js';
import { DATABASE } from '../database/database.module.js';
import { recordPermissions } from '../documents/record-access.js';
import { ReorderService } from '../reorder/reorder.service.js';
import { StockCountsService } from '../stock-counts/stock-counts.service.js';
import { TransfersService } from '../transfers/transfers.service.js';
import type { InboxQueryInput } from './inbox.schemas.js';

const { stores } = schema;

/** An item before its store is named. */
type Draft = Omit<InboxItem, 'kind' | 'store'> & { readonly storeId: string | null };

interface Found {
  readonly total: number;
  readonly items: readonly Draft[];
}

interface Filter {
  readonly storeId?: string;
  readonly limit: number;
}

/** One queue the inbox reads: who may be asked about it, and its items. */
interface Source {
  readonly kind: InboxKind;
  readonly allowed: (auth: AuthContext) => boolean;
  readonly load: (auth: AuthContext, filter: Filter) => Promise<Found>;
}

const action = (
  key: InboxAction['key'],
  endpoint: string,
  input: InboxAction['input'],
): InboxAction => ({ key, endpoint, input });

const NO_FIGURES = { amountPaise: null, due: null, quantity: null, requestedBy: null } as const;

/**
 * The "Needs action" inbox (docs/mvp-3/navigation-ux.md, step 2): what waits on
 * the member across the queues that already exist. Each queue is read through
 * its own service, with the same permissions, store scope and rules as its
 * screen, in a fixed number of queries whatever its length. No new rules here:
 * who may act is who the queue's own endpoint lets act.
 */
@Injectable()
export class InboxService {
  /** In the order of INBOX_KINDS. */
  private readonly sources: readonly Source[];

  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(CreditApprovalsService) approvals: CreditApprovalsService,
    @Inject(CreditService) credit: CreditService,
    @Inject(TransfersService) transfers: TransfersService,
    @Inject(StockCountsService) counts: StockCountsService,
    @Inject(CollectionsService) collections: CollectionsService,
    @Inject(ActivitiesService) activities: ActivitiesService,
    @Inject(ReorderService) reorder: ReorderService,
  ) {
    this.sources = [
      {
        kind: 'credit_approval',
        // The queue's screen needs credit:read; deciding, the level's approver.
        allowed: (auth) =>
          can(auth, 'credit:read') &&
          (auth.role.key === 'owner' ||
            can(auth, 'credit:approve') ||
            can(auth, 'credit:approve_sale')),
        load: async (auth, { storeId, limit }) => {
          // "mine": pending, decidable by this member, never their own request.
          const page = await approvals.list(auth, {
            mine: true,
            ...(storeId === undefined ? {} : { storeId }),
            limit,
            offset: 0,
          });
          return {
            total: page.total,
            items: page.items.map((approval) => ({
              id: approval.id,
              step: approval.kind === 'release' ? 'approve_release' : 'approve_sale',
              reference: approval.number,
              title: approval.party.name,
              requestedBy: approval.requestedBy.name,
              storeId: approval.store?.id ?? null,
              amountPaise: approval.kind === 'sale' ? approval.amountPaise : null,
              since: approval.createdAt,
              due: null,
              quantity: null,
              // A sale or a customer on hold waits on it.
              priority: 'high',
              link: `/credit/approvals/${approval.id}`,
              actions: [
                action('approve', `/credit-approvals/${approval.id}/approve`, 'note'),
                action('reject', `/credit-approvals/${approval.id}/reject`, 'reason'),
              ],
            })),
          };
        },
      },
      {
        kind: 'credit_request',
        allowed: (auth) => can(auth, 'credit:read') && can(auth, 'credit:approve'),
        load: async (auth, { storeId, limit }) => {
          // Not their own request, unless nobody else approves credit.
          const page = await credit.requestPage(auth, {
            status: 'pending',
            decidable: true,
            ...(storeId === undefined ? {} : { storeId }),
            limit,
            offset: 0,
          });
          return {
            total: page.total,
            items: page.items.map(({ request, storeId: home }) => ({
              ...NO_FIGURES,
              id: request.id,
              step: 'decide_request',
              reference: request.number,
              title: request.party.name,
              requestedBy: request.requestedBy.name,
              storeId: home,
              amountPaise: request.limitPaise,
              since: request.createdAt,
              priority: 'normal',
              link: `/credit-requests/${request.id}`,
              actions: [
                action('approve', `/credit-requests/${request.id}/approve`, 'note'),
                action('reject', `/credit-requests/${request.id}/reject`, 'reason'),
              ],
            })),
          };
        },
      },
      {
        kind: 'transfer',
        // Every step of a transfer needs inventory:manage at the right end of it.
        allowed: (auth) => can(auth, 'inventory:read') && can(auth, 'inventory:manage'),
        load: async (auth, { storeId, limit }) => {
          const store = storeId === undefined ? {} : { storeId };
          const steps = [
            { step: 'approve_transfer', status: 'requested', direction: 'outgoing' },
            { step: 'dispatch_transfer', status: 'approved', direction: 'outgoing' },
            { step: 'receive_transfer', status: 'in_transit', direction: 'incoming' },
          ] as const;
          let total = 0;
          const items: Draft[] = [];
          for (const { step, status, direction } of steps) {
            const page = await transfers.list(auth, {
              status,
              direction,
              ...store,
              limit,
              offset: 0,
            });
            total += page.total;
            for (const transfer of page.items) {
              const approving = step === 'approve_transfer';
              items.push({
                ...NO_FIGURES,
                id: transfer.id,
                step,
                reference: transfer.number,
                title: `${transfer.from.name} → ${transfer.to.name}`,
                storeId: step === 'receive_transfer' ? transfer.to.id : transfer.from.id,
                since: transfer.requestedAt,
                // Stock on the road is stock no store can sell.
                priority: step === 'receive_transfer' ? 'high' : 'normal',
                link: `/transfers/${transfer.id}`,
                // Approving in full needs nothing more; dispatching and receiving
                // take quantities (and a challan), on the transfer's page.
                actions: approving
                  ? [
                      action('approve', `/transfers/${transfer.id}/approve`, 'none'),
                      action('reject', `/transfers/${transfer.id}/reject`, 'reason'),
                    ]
                  : [],
              });
            }
          }
          return { total, items: items.slice(0, limit) };
        },
      },
      {
        kind: 'stock_count',
        allowed: (auth) => can(auth, 'inventory:read') && can(auth, 'inventory:manage'),
        load: async (auth, { storeId, limit }) => {
          // Approving gives each difference a reason: on the count's page.
          const page = await counts.list(auth, {
            ...(storeId === undefined ? {} : { storeId }),
            awaitingMe: true,
            limit,
            offset: 0,
          });
          return {
            total: page.total,
            items: page.items.map((count) => ({
              ...NO_FIGURES,
              id: count.id,
              step: 'approve_count',
              reference: null,
              title: count.number,
              requestedBy: count.submittedBy,
              storeId: count.store.id,
              since: count.submittedAt,
              priority: 'normal',
              link: `/stock-counts/${count.id}`,
              actions: [],
            })),
          };
        },
      },
      {
        kind: 'escalation',
        // The collections screen needs receivables:read; acknowledging, credit:manage.
        allowed: (auth) => can(auth, 'receivables:read') && can(auth, 'credit:manage'),
        load: async (auth, { storeId, limit }) => {
          const page = await collections.escalationPage(auth, {
            open: true,
            ...(storeId === undefined ? {} : { storeId }),
            limit,
          });
          return {
            total: page.total,
            items: page.items.map(({ escalation, storeId: home }) => ({
              ...NO_FIGURES,
              id: escalation.id,
              step: 'acknowledge_escalation',
              reference: null,
              title: escalation.party.name,
              storeId: home,
              amountPaise: escalation.promise.amountPaise,
              since: escalation.raisedOn,
              due: escalation.promise.promisedOn,
              priority: 'high',
              link: `/parties/${escalation.party.id}`,
              actions: [
                action(
                  'acknowledge',
                  `/collections/escalations/${escalation.id}/acknowledge`,
                  'note',
                ),
              ],
            })),
          };
        },
      },
      {
        kind: 'follow_up',
        // Everyone has their own follow-ups.
        allowed: () => true,
        load: async (auth, { storeId, limit }) => {
          const store = storeId === undefined ? {} : { storeId };
          let total = 0;
          const items: Draft[] = [];
          for (const when of ['overdue', 'today'] as const) {
            const page = await activities.followUps(auth, {
              when,
              assignedTo: 'me',
              ...store,
              limit,
              offset: 0,
            });
            total += page.total;
            for (const followUp of page.items) {
              const manage = auth.permissions.has(recordPermissions(followUp.record.type).manage);
              items.push({
                ...NO_FIGURES,
                id: followUp.id,
                step: when === 'overdue' ? 'follow_up_overdue' : 'follow_up_today',
                reference: followUp.record.label,
                title: followUp.subject,
                storeId: null,
                since: followUp.createdAt,
                due: followUp.dueAt,
                priority: when === 'overdue' ? 'high' : 'normal',
                link: `${RECORD_PATHS[followUp.record.type]}${followUp.record.id}`,
                // Changing an activity needs the manage permission of its record.
                actions: manage
                  ? [action('complete', `/activities/${followUp.id}/complete`, 'note')]
                  : [],
              });
            }
          }
          return { total, items: items.slice(0, limit) };
        },
      },
      {
        kind: 'low_stock',
        // Whoever buys at the store; where nobody of its own does, who manages its stock.
        allowed: (auth) =>
          can(auth, 'inventory:read') &&
          (can(auth, 'inventory:manage') || can(auth, 'purchasing:manage')),
        load: async (auth, { storeId, limit }) => {
          const page = await reorder.lowStock(
            auth,
            { ...(storeId === undefined ? {} : { storeId }), limit, offset: 0 },
            true,
          );
          return {
            total: page.total,
            items: page.items.map((item) => ({
              ...NO_FIGURES,
              id: `${item.store.id}:${item.variant.id}`,
              step: item.severity,
              reference: item.variant.sku,
              title: variantTitle(item.brand.name, item.product.name, item.variant),
              storeId: item.store.id,
              since: null,
              quantity: {
                available: item.available,
                reorderLevel: item.reorderLevel,
                suggested: item.suggestedQuantity,
                unit: item.variant.unit,
              },
              priority:
                item.severity === 'out_of_stock'
                  ? 'high'
                  : item.severity === 'below_minimum'
                    ? 'normal'
                    : 'low',
              link: `/stock/low?store=${item.store.id}`,
              actions: [],
            })),
          };
        },
      },
    ];
  }

  /** Everything waiting on the member, grouped by kind, the first items of each. */
  async inbox(auth: AuthContext, query: InboxQueryInput): Promise<InboxView> {
    this.assertStore(auth, query.storeId);
    const allowed = this.allowed(auth);
    const groups: InboxGroup[] = [];
    let total = 0;
    const found: { kind: InboxKind; found: Found }[] = [];
    for (const source of allowed) {
      if (query.kind !== undefined && source.kind !== query.kind) continue;
      found.push({
        kind: source.kind,
        found: await source.load(auth, { storeId: query.storeId, limit: INBOX_GROUP_LIMIT }),
      });
    }
    const names = await this.storeNames(auth);
    for (const { kind, found: group } of found) {
      total += group.total;
      if (group.total === 0) continue;
      groups.push({
        kind,
        total: group.total,
        items: group.items.map(({ storeId, ...item }) => ({
          ...item,
          kind,
          store: storeId === null ? null : { id: storeId, name: String(names.get(storeId)) },
        })),
      });
    }
    return { kinds: allowed.map((source) => source.kind), groups, total };
  }

  /** How many items wait on the member, for the badge: the same queues, one row each. */
  async count(auth: AuthContext): Promise<InboxCount> {
    let total = 0;
    for (const source of this.allowed(auth)) {
      total += (await source.load(auth, { limit: 1 })).total;
    }
    return { total };
  }

  private allowed(auth: AuthContext): Source[] {
    return this.sources.filter((source) => source.allowed(auth));
  }

  private assertStore(auth: AuthContext, storeId: string | undefined): void {
    if (storeId !== undefined && !canAccessStore(auth, storeId)) {
      throw new NotFoundException('Store not found');
    }
  }

  /** Every store's name, in one query. */
  private storeNames(auth: AuthContext): Promise<Map<string, string>> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const rows = await tx.select({ id: stores.id, name: stores.name }).from(stores);
      return new Map(rows.map((row) => [row.id, row.name]));
    });
  }
}
