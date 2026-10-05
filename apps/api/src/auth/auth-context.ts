import type { AuthProfile, MemberAccess } from '@paint/shared';

/** The shape returned by GET /auth/me. */
export type { AuthProfile };

/** Who is making the request, in which organisation, and what they may do. */
export interface AuthContext extends MemberAccess {
  readonly sessionId: string;
  readonly memberId: string;
  readonly user: {
    readonly id: string;
    readonly fullName: string;
    readonly phone: string | null;
    readonly email: string | null;
  };
  readonly organization: { readonly id: string; readonly name: string };
  readonly role: { readonly key: string; readonly name: string };
  /** Set when platform support is signed in through an approved support grant. */
  readonly supportGrantId?: string;
}

export function toProfile(auth: AuthContext): AuthProfile {
  return {
    memberId: auth.memberId,
    user: auth.user,
    organization: auth.organization,
    role: auth.role,
    permissions: [...auth.permissions].sort(),
    allStores: auth.allStores,
    storeIds: [...auth.storeIds].sort(),
  };
}

/** A request after AuthGuard has run. */
export interface AuthenticatedRequest {
  auth?: AuthContext;
}

/** The AuthContext attached by AuthGuard. Throws if used on a public route. */
export function authFromRequest(request: AuthenticatedRequest): AuthContext {
  if (!request.auth) {
    throw new Error('No signed-in user on this request. Is the route marked @Public()?');
  }
  return request.auth;
}
