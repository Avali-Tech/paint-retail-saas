import type { Branding } from './branding.js';
import type { Permission } from './permissions.js';
import type { QuickAction } from './quick-actions.js';
import type { ThemeAdjustment } from './theme.js';

// Response shapes of API routes, shared by apps/api (which returns them) and
// apps/web (which reads them), so the two cannot drift apart.

/** POST /auth/login, /auth/otp/verify, /auth/signup. */
export interface SessionGrant {
  /** Give to the client once; send back as "Authorization: Bearer <token>". */
  readonly token: string;
  readonly expiresAt: string;
  readonly organizationId: string;
}

/** The second step of a sign-in, when two-factor sign-in applies. */
export interface PendingSignIn {
  /** Send with the code to POST /auth/2fa/verify (or /platform/login/2fa); lasts 5 minutes. */
  readonly pendingToken: string;
  readonly expiresAt: string;
  /** True when the person must first add an authenticator app (POST …/2fa/setup). */
  readonly setupRequired: boolean;
}

/** POST /auth/login and /auth/otp/verify: a session, or the two-factor step first. */
export type SignInResult = SessionGrant | { readonly twoFactor: PendingSignIn };

/** POST /auth/2fa/verify: the session, plus recovery codes when an app was just added. */
export type TwoFactorSignIn = SessionGrant & { readonly recoveryCodes?: string[] };

/** GET /auth/me. */
export interface AuthProfile {
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

/** One store's row on the dashboard. Sections the member cannot see are null. */
export interface StorePosition {
  readonly store: { readonly id: string; readonly code: string; readonly name: string };
  /** Null without inventory:read. */
  readonly stock: {
    readonly valuePaise: number;
    readonly units: number;
    readonly skus: number;
    /** In stock but without a cost, so missing from the value. */
    readonly uncostedSkus: number;
  } | null;
  readonly lowStock: {
    readonly outOfStock: number;
    readonly belowMinimum: number;
    readonly reorder: number;
  } | null;
  readonly transfers: {
    /** Requested from this store, waiting for its approval. */
    readonly awaitingApproval: number;
    /** Approved here, waiting to be dispatched. */
    readonly toDispatch: number;
    /** Dispatched to this store, not yet received. */
    readonly incoming: number;
  } | null;
  /** Null without purchasing:read. */
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
  /** Everything above added up across the stores shown. */
  readonly totals: Omit<StorePosition, 'store'>;
  /** Null without leads:read. */
  readonly leads: StageCount[] | null;
  readonly opportunities: (StageCount & { readonly weightedValuePaise: number })[] | null;
  /** Null without projects:read. */
  readonly projects: StageCount[] | null;
  /** Open follow-ups at these stores (and business-wide ones), by India time. */
  readonly followUps: { readonly overdue: number; readonly today: number };
}

export interface SearchHit {
  readonly id: string;
  /** Main line, e.g. a name or "Asian Paints Apex Ultima 20 l". */
  readonly title: string;
  /** Second line, e.g. a mobile number, SKU or stage. */
  readonly subtitle: string | null;
  /** Where the web app opens it. */
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
  /** Parties with loyalty accounts, by name or mobile number, with their points. */
  readonly loyalty: SearchHit[] | null;
  /** Transfers, purchase orders, goods receipts and stock counts found by number. */
  readonly documents: SearchHit[];
}

export interface NotificationView {
  readonly id: string;
  /** A notification event key, e.g. "low_stock". */
  readonly event: string;
  readonly title: string;
  readonly body: string;
  readonly link: string;
  readonly createdAt: string;
  readonly readAt: string | null;
}

/** GET /notifications. */
export interface NotificationPage {
  readonly items: NotificationView[];
  readonly total: number;
  /** Unread notifications in all, for the badge. */
  readonly unread: number;
}

/** GET /organization/branding (404 until the business sets its branding). */
export interface BrandingView {
  readonly branding: Branding;
  readonly updatedAt: string;
}

/** PUT /organization/branding: what was saved, and how the theme had to adjust it to stay readable. */
export interface BrandingSaved {
  readonly branding: Branding;
  readonly adjustments: ThemeAdjustment[];
}
