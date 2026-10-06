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

/**
 * Why POST /auth/2fa/verify (or /platform/login/2fa) refused a code, sent as
 * `code` beside the message: a wrong code while tries remain, a sign-in that
 * has expired or was already used, or one whose tries are used up.
 */
export type TwoFactorErrorCode = 'wrong_code' | 'expired' | 'too_many_attempts';

/** The 401 body of a refused two-factor code. */
export interface TwoFactorError {
  readonly statusCode: 401;
  readonly message: string;
  readonly code: TwoFactorErrorCode;
  /** Tries left on this pending sign-in (0 once they are used up); absent when it has expired. */
  readonly attemptsRemaining?: number;
}

/**
 * Why POST /documents refused a file, beside the message: empty, not an
 * accepted kind, over 10 MB, the virus scanner or file storage is down, or a
 * virus was found.
 */
export type DocumentUploadErrorCode =
  | 'empty_file'
  | 'file_type'
  | 'too_large'
  | 'scanner_unavailable'
  | 'storage_unavailable'
  | 'virus_found';

/** The body of a refused upload. */
export interface DocumentUploadError {
  readonly statusCode: number;
  readonly message: string;
  readonly code: DocumentUploadErrorCode;
}

/** GET /auth/me. */
export interface AuthProfile {
  /** The signed-in person's membership in this business (organization_members.id). */
  readonly memberId: string;
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
  /**
   * Open follow-ups on records the member can see, by India time, counted as
   * GET /activities/follow-ups counts them: everyone's (`team`, for members
   * with members:read, as `assignedTo=everyone`) or the member's own (`mine`),
   * at the chosen store or every store they work at.
   */
  readonly followUps: {
    readonly scope: 'team' | 'mine';
    readonly overdue: number;
    readonly today: number;
  };
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

/** GET /stores/directory: every open store of the business, for pickers (e.g. where to ask for stock). */
export interface StoreDirectoryEntry {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** GET /roles: a role with its permissions. System roles cannot be changed. */
export interface RoleView {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly permissions: Permission[];
  /** Active members holding the role. */
  readonly memberCount: number;
}

/** GET /members: one person on the team. */
export interface MemberView {
  readonly id: string;
  readonly user: {
    readonly id: string;
    readonly fullName: string;
    readonly phone: string | null;
    readonly email: string | null;
  };
  readonly role: { readonly id: string; readonly key: string; readonly name: string };
  readonly allStores: boolean;
  readonly storeIds: string[];
  readonly isActive: boolean;
  /** Whether the person has a confirmed authenticator app. */
  readonly twoFactorEnabled: boolean;
}

/**
 * GET /members/assignable: someone a record can be handed to, for pickers.
 * Only what choosing needs; no contact details.
 */
export interface AssignableMember {
  readonly id: string;
  readonly name: string;
  /** The role's name, e.g. "Sales Executive". */
  readonly role: string;
  readonly allStores: boolean;
  /** Their stores among those the asker works at. */
  readonly storeIds: string[];
}
