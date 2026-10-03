// Response shapes of the API routes the web app uses, shared with apps/api
// through @paint/shared so the two cannot drift apart.

export type {
  AuthProfile as Profile,
  BrandingSaved,
  BrandingView,
  Dashboard,
  NotificationView as Notification,
  NotificationPage,
  PendingSignIn,
  SearchHit,
  SearchResults,
  SessionGrant,
  SignInResult,
  StageCount,
  StorePosition,
  TwoFactorSignIn,
} from '@paint/shared';

// The routes below have no shared type yet; these mirror apps/api/src/auth/two-factor.*
// and MemberView in apps/api/src/members/members.service.ts.

/** POST /auth/2fa/setup and /auth/2fa/enrol: an authenticator app to add. */
export interface TwoFactorEnrolment {
  /** Base32, for typing into the app by hand. */
  readonly secret: string;
  /** otpauth:// URI, shown as a QR code. */
  readonly otpauthUri: string;
}

/** GET /auth/2fa: the member's own two-factor sign-in. */
export interface TwoFactorStatus {
  readonly enabled: boolean;
  readonly recoveryCodesLeft: number;
  /** Whether the business requires it of the member's role (then it cannot be turned off). */
  readonly required: boolean;
}

/** GET and PUT /organization/security. */
export interface OrganizationSecurity {
  readonly twoFactorRequired: boolean;
}

/** GET /members: one person on the team. */
export interface Member {
  readonly id: string;
  readonly user: {
    readonly id: string;
    readonly fullName: string;
    readonly phone: string | null;
    readonly email: string | null;
  };
  readonly role: { readonly id: string; readonly key: string; readonly name: string };
  readonly isActive: boolean;
}
