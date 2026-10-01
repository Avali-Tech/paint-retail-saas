import { z } from 'zod';

export const dashboardSchema = z.object({ storeId: z.uuid().optional() });
