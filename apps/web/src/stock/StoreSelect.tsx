import { Field, Select } from '@paint/ui';
import type { Store } from '../api/stock.js';
import { useCurrentProfile } from '../auth/session.js';
import { useStores } from './stores.js';

/** True when the signed-in member works at the store (or at every store). */
export function useStoreAccess(): (storeId: string) => boolean {
  const profile = useCurrentProfile();
  return (storeId) => profile.allStores || profile.storeIds.includes(storeId);
}

/** "HYD · Hyderabad". */
export const storeLabel = (store: Pick<Store, 'code' | 'name'>) => `${store.code} · ${store.name}`;

export interface StoreSelectProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (storeId: string) => void;
  /** The empty choice, e.g. "All stores" for a filter or "Choose a store" for a form. */
  readonly emptyLabel: string;
  readonly error?: string | undefined;
  readonly required?: boolean;
  /** Leave out stores, e.g. the sending store when choosing where stock goes. */
  readonly exclude?: string;
}

/**
 * A store picker over the stores the member works at (GET /stores). A required
 * choice (a form) offers only open stores; a filter also offers closed ones,
 * whose history is still worth seeing.
 */
export function StoreSelect({
  label,
  value,
  onChange,
  emptyLabel,
  error,
  required = false,
  exclude,
}: StoreSelectProps) {
  const stores = useStores();
  return (
    <Field label={label} error={error} required={required}>
      <Select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">{emptyLabel}</option>
        {(stores.data ?? [])
          .filter((store) => store.id !== exclude && (store.isActive || !required))
          .map((store) => (
            <option key={store.id} value={store.id}>
              {storeLabel(store)}
            </option>
          ))}
      </Select>
    </Field>
  );
}
