import { Alert, Button, Field, Input, Select, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FreeStock } from '../api/stock.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { parseQuantity } from '../lib/quantity.js';
import type { BillLine } from './bill.js';

/** Asks another store to send stock here (spec: transfers); it waits for that store's approval. */
function RequestDialog({
  storeId,
  line,
  sources,
  nearest,
  shortBy,
  onClose,
}: {
  readonly storeId: string;
  readonly line: BillLine;
  readonly sources: readonly FreeStock[];
  /** The store with the most free, chosen first. */
  readonly nearest: FreeStock;
  readonly shortBy: number;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(nearest);
  const [quantity, setQuantity] = useState(String(shortBy));
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('pos.stock.requestTitle')}
      description={line.name}
      submitLabel={t('pos.stock.request')}
      onSubmit={async () => {
        const wanted = parseQuantity(quantity);
        if (wanted === null || wanted <= 0 || wanted > from.available) {
          return t('pos.stock.quantityInvalid', { available: String(from.available) });
        }
        const transfer = await api.transfers.create({
          fromStoreId: from.store.id,
          toStoreId: storeId,
          lines: [{ variantId: line.variantId, quantity: wanted }],
        });
        await queryClient.invalidateQueries({ queryKey: ['transfers'] });
        toast({ title: t('pos.stock.requested', { number: transfer.number }), tone: 'success' });
        return undefined;
      }}
    >
      <Field label={t('pos.stock.from')}>
        <Select
          value={from.store.id}
          onChange={(event) => {
            // The options are the sources, in order, so the chosen index is always one of them.
            const at = event.target.selectedIndex;
            const [picked] = sources.slice(at, at + 1) as [FreeStock];
            setFrom(picked);
          }}
        >
          {sources.map((source) => (
            <option key={source.store.id} value={source.store.id}>
              {t('pos.stock.source', { store: source.store.name, count: String(source.available) })}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('pos.stock.quantity')}>
        <Input
          inputMode="decimal"
          value={quantity}
          onChange={(event) => {
            setQuantity(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

/**
 * What bringing the line's stock from `source` keeps: the line's value before
 * GST, less its cost there, less the delivery. Null when it cannot be told
 * (no cost, no delivery cost set, or the bill cannot be priced yet).
 */
export function keptByDelivery(
  taxablePaise: number | null,
  quantity: number,
  source: FreeStock,
  deliveryCostPaise: number | null,
): { marginPaise: number; keptPaise: number } | null {
  if (taxablePaise === null || source.avgCostPaise === null || deliveryCostPaise === null) {
    return null;
  }
  const marginPaise = taxablePaise - Math.round(source.avgCostPaise * quantity);
  return { marginPaise, keptPaise: marginPaise - deliveryCostPaise };
}

/** The delivery weighed against the margin: worth it, or costing more than it earns. */
function DeliveryWeighed({
  kept,
  deliveryCostPaise,
  money,
}: {
  readonly kept: { marginPaise: number; keptPaise: number } | null;
  readonly deliveryCostPaise: number | null;
  readonly money: (paise: number) => string;
}) {
  const { t } = useI18n();
  if (kept === null || deliveryCostPaise === null) return null;
  const amounts = {
    margin: money(kept.marginPaise),
    delivery: money(deliveryCostPaise),
    kept: money(Math.abs(kept.keptPaise)),
  };
  return (
    <span className="cell-meta">
      {kept.keptPaise >= 0 ? t('pos.stock.worthIt', amounts) : t('pos.stock.notWorthIt', amounts)}
    </span>
  );
}

/**
 * For the selected line, when this store cannot cover it: how much is free here,
 * which other stores have it free, and a request to send it here. Shows nothing
 * while this store has enough.
 */
export function StockElsewhere({
  storeId,
  line,
  taxablePaise,
}: {
  readonly storeId: string;
  readonly line: BillLine;
  /** The line's value before GST, from the bill's preview; null while it cannot be priced. */
  readonly taxablePaise: number | null;
}) {
  const api = useApi();
  const { t, number, money } = useI18n();
  const can = usePermissions();
  const [requesting, setRequesting] = useState(false);
  const free = useQuery({
    queryKey: ['free-elsewhere', line.variantId],
    queryFn: ({ signal }) => api.stock.freeElsewhere(line.variantId, signal),
    enabled: can('inventory:read'),
  });
  if (free.data === undefined) return null;
  const { deliveryCostPaise } = free.data;
  const here = free.data.stores.find((row) => row.store.id === storeId)?.available ?? 0;
  if (line.quantity <= here) return null;
  const sources = free.data.stores.filter((row) => row.store.id !== storeId);
  // The API answers the store with the most free first.
  const [nearest] = sources;
  const shortBy = line.quantity - here;
  return (
    <Alert tone="warning">
      <p>{t('pos.stock.short', { count: number(here), wanted: number(line.quantity) })}</p>
      {nearest === undefined ? (
        <p>{t('pos.stock.nowhere')}</p>
      ) : (
        <>
          <ul aria-label={t('pos.stock.elsewhere')}>
            {sources.map((source) => (
              <li key={source.store.id}>
                {t('pos.stock.source', {
                  store: source.store.name,
                  count: number(source.available),
                })}
                <DeliveryWeighed
                  kept={keptByDelivery(taxablePaise, line.quantity, source, deliveryCostPaise)}
                  deliveryCostPaise={deliveryCostPaise}
                  money={money}
                />
              </li>
            ))}
          </ul>
          {/* Everyone at the counter bills here (the route needs billing:issue); the server checks the store. */}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setRequesting(true);
            }}
          >
            {t('pos.stock.requestHere')}
          </Button>
          {requesting && (
            <RequestDialog
              storeId={storeId}
              line={line}
              sources={sources}
              nearest={nearest}
              shortBy={shortBy}
              onClose={() => {
                setRequesting(false);
              }}
            />
          )}
        </>
      )}
    </Alert>
  );
}
