import { z } from 'zod';

const token = z.string().trim().min(20).max(200);
/** A 6-digit code from the app, or a recovery code like "k7pq-2mxa". */
const code = z.string().trim().min(6).max(20);

export const pendingSchema = z.object({ pendingToken: token });
export const pendingCodeSchema = z.object({ pendingToken: token, code });
export const codeSchema = z.object({ code });
export const securitySchema = z.object({ twoFactorRequired: z.boolean() });
