import { createHash } from 'node:crypto';
import {
  UnprocessableEntityException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import { and, eq, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';

const { idempotencyKeys } = schema;

/** What makes two requests "the same": method, path and body. */
export interface IdempotentRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const hashOf = (request: IdempotentRequest) =>
  createHash('sha256')
    .update(`${request.method} ${request.path} ${JSON.stringify(request.body)}`)
    .digest('hex');

/**
 * Runs `work` once per `Idempotency-Key` (spec §5.1): a repeat of the same
 * request returns the first response; the same key with another request is
 * refused. The key is claimed in the caller's transaction, so a concurrent
 * repeat waits for the first to finish, and a failed request frees its key.
 * Keys older than 24 hours are purged as new ones arrive.
 */
export async function idempotent<T>(
  tx: Transaction,
  auth: AuthContext,
  key: string | undefined,
  request: IdempotentRequest,
  work: () => Promise<T>,
): Promise<T> {
  if (key === undefined) return work();
  await tx.execute(
    sql`delete from ${idempotencyKeys} where ${idempotencyKeys.createdAt} < now() - interval '24 hours'`,
  );
  const requestHash = hashOf(request);
  const claimed = await tx
    .insert(idempotencyKeys)
    .values({ organizationId: auth.organization.id, memberId: auth.memberId, key, requestHash })
    .onConflictDoNothing()
    .returning({ id: idempotencyKeys.id });
  if (claimed.length === 0) {
    const [earlier] = await tx
      .select({ requestHash: idempotencyKeys.requestHash, response: idempotencyKeys.response })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.memberId, auth.memberId), eq(idempotencyKeys.key, key)));
    if (earlier?.requestHash === requestHash) return earlier.response as T;
    throw new UnprocessableEntityException(
      'This Idempotency-Key was already used for a different request',
    );
  }
  const response = await work();
  await tx
    .update(idempotencyKeys)
    .set({ response })
    .where(and(eq(idempotencyKeys.memberId, auth.memberId), eq(idempotencyKeys.key, key)));
  return response;
}

/** Reads the request's `Idempotency-Key` header (validate it with a pipe). */
export function idempotencyKeyOf(_data: unknown, context: ExecutionContext): unknown {
  return context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>().headers[
    'idempotency-key'
  ];
}

/** Injects the `Idempotency-Key` header into a route handler parameter. */
export const IdempotencyKey = createParamDecorator(idempotencyKeyOf);
