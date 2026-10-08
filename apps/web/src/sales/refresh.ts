import type { QueryClient } from '@tanstack/react-query';

/** After a return or a note: invoices, their adjustments and the note lists load again. */
export async function refreshSales(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['invoices'] }),
    queryClient.invalidateQueries({ queryKey: ['notes'] }),
  ]);
}
