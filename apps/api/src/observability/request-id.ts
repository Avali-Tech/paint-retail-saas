import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

const SAFE_REQUEST_ID = /^[\w-]{8,128}$/;

/** Keeps a caller's well-formed X-Request-Id (to follow a request across systems), else a new UUID. */
export function requestIdFor(header: string | string[] | undefined): string {
  return typeof header === 'string' && SAFE_REQUEST_ID.test(header) ? header : randomUUID();
}

export function generateRequestId(request: { readonly headers: IncomingHttpHeaders }): string {
  return requestIdFor(request.headers[REQUEST_ID_HEADER]);
}

/**
 * Gives every request an id that is unique across servers (Fastify's default is a
 * per-process counter) and returns it on every response, so a user can quote it and
 * support can find the error report. Must run before the server starts listening.
 */
export function installRequestIds(fastify: FastifyInstance): void {
  fastify.setGenReqId(generateRequestId);
  fastify.addHook('onRequest', (request, reply, done) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });
}
