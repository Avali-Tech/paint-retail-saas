import { z } from 'zod';

/** PUT /organization/slug; the name itself is checked by validateSlug from @paint/shared. */
export const slugSchema = z.object({ slug: z.string().max(200) });
