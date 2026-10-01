import type { Permission, QuickAction } from '@paint/shared';

// Response shapes of the API routes the web app uses. They mirror apps/api;
// the end-to-end tests run against the real API, so any drift fails there.

/** POST /auth/login, /auth/otp/verify, /auth/signup. */
export interface SessionGrant {
  readonly token: string;
  readonly expiresAt: string;
  readonly organizationId: string;
}

/** GET /auth/me. */
export interface Profile {
  readonly user: {
    readonly id: string;
    readonly fullName: string;
    readonly phone: string | null;
    readonly email: string | null;
  };
  readonly organization: { readonly id: string; readonly name: string };
  readonly role: { readonly key: string; readonly name: string };
  readonly permissions: Permission[];
  readonly allStores: boolean;
  readonly storeIds: string[];
}

export interface StorePosition {
  readonly store: { readonly id: string; readonly code: string; readonly name: string };
  readonly stock: {
    readonly valuePaise: number;
    readonly units: number;
    readonly skus: number;
    readonly uncostedSkus: number;
  } | null;
  readonly lowStock: {
    readonly outOfStock: number;
    readonly belowMinimum: number;
    readonly reorder: number;
  } | null;
  readonly transfers: {
    readonly awaitingApproval: number;
    readonly toDispatch: number;
    readonly incoming: number;
  } | null;
  readonly purchaseOrders: { readonly open: number; readonly dueValuePaise: number } | null;
}

export interface StageCount {
  readonly stage: string;
  readonly count: number;
  readonly valuePaise: number;
}

/** GET /dashboard. Sections the member cannot see are null. */
export interface Dashboard {
  readonly generatedAt: string;
  readonly stores: StorePosition[];
  readonly totals: Omit<StorePosition, 'store'>;
  readonly leads: StageCount[] | null;
  readonly opportunities: (StageCount & { readonly weightedValuePaise: number })[] | null;
  readonly projects: StageCount[] | null;
  readonly followUps: { readonly overdue: number; readonly today: number };
}

export interface SearchHit {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly path: string;
}

/** GET /search. Groups the member cannot see are null. */
export interface SearchResults {
  readonly query: string;
  readonly actions: QuickAction[];
  readonly parties: SearchHit[] | null;
  readonly products: SearchHit[] | null;
  readonly leads: SearchHit[] | null;
  readonly opportunities: SearchHit[] | null;
  readonly projects: SearchHit[] | null;
  readonly contracts: SearchHit[] | null;
  readonly documents: SearchHit[];
}

export interface Notification {
  readonly id: string;
  readonly event: string;
  readonly title: string;
  readonly body: string;
  readonly link: string;
  readonly createdAt: string;
  readonly readAt: string | null;
}

/** GET /notifications. */
export interface NotificationPage {
  readonly items: Notification[];
  readonly total: number;
  readonly unread: number;
}
