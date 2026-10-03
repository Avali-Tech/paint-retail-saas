import { Badge, Field, Select, type Tone } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import type { PurchaseOrderStatus } from '../api/purchasing.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';

/** Every supplier, for pickers (the API answers at most 200 at a time). */
export function useSupplierOptions() {
  const api = useApi();
  return useQuery({
    queryKey: ['suppliers', 'all'],
    queryFn: () => api.purchasing.suppliers({ limit: 200 }),
  });
}

/** One supplier with the products it provides; idle until one is chosen. */
export function useSupplier(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['supplier', id],
    queryFn: ({ signal }) => api.purchasing.supplier(id, signal),
    enabled: id !== '',
  });
}

const STATUS_TONE: Record<PurchaseOrderStatus, Tone> = {
  open: 'info',
  partially_received: 'warning',
  received: 'success',
  closed: 'neutral',
  cancelled: 'neutral',
};

export function OrderStatusBadge({ status }: { readonly status: PurchaseOrderStatus }) {
  const { label } = useI18n();
  return <Badge tone={STATUS_TONE[status]}>{label('purchaseOrderStatus', status)}</Badge>;
}

/** "30 days", or "Cash" for no credit. */
export function useDays() {
  const { t } = useI18n();
  return {
    terms: (days: number) => (days === 0 ? t('purchasing.cash') : t('purchasing.days', { days })),
    days: (days: number | null) =>
      days === null ? t('common.none') : t('purchasing.days', { days }),
  };
}

export interface SupplierSelectProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (supplierId: string) => void;
  readonly emptyLabel: string;
  readonly error?: string | undefined;
  readonly required?: boolean;
}

export function SupplierSelect({
  label,
  value,
  onChange,
  emptyLabel,
  error,
  required = false,
}: SupplierSelectProps) {
  const suppliers = useSupplierOptions();
  return (
    <Field label={label} error={error} required={required}>
      <Select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">{emptyLabel}</option>
        {(suppliers.data?.items ?? []).map((supplier) => (
          <option key={supplier.id} value={supplier.id}>
            {supplier.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}
