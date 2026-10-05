import { useQuery } from '@tanstack/react-query';
import { useApi } from '../app/services.js';

/** The stores the member works at (GET /stores), for store pickers. */
export function useStores() {
  const api = useApi();
  return useQuery({ queryKey: ['stores'], queryFn: () => api.stock.stores() });
}

/** Every open store of the business (GET /stores/directory), e.g. which store to ask for stock. */
export function useStoreDirectory() {
  const api = useApi();
  return useQuery({ queryKey: ['stores', 'directory'], queryFn: () => api.stock.storeDirectory() });
}
