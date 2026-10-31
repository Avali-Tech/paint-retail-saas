import { INBOX_KINDS } from '@paint/shared';
import { z } from 'zod';

export const inboxQuerySchema = z.object({
  /** One kind of item only. */
  kind: z.enum(INBOX_KINDS).optional(),
  /** Items at one store only. */
  storeId: z.uuid().optional(),
});
export type InboxQueryInput = z.output<typeof inboxQuerySchema>;
