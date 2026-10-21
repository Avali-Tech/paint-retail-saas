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
 * For the selected line, when this store cannot cover it: how much is free here,
 * which other stores have it free, and a request to send it here. Shows nothing
 * while this store has enough.
 */
export function StockElsewhere({
  storeId,
  line,
}: {
  readonly storeId: string;
  readonly line: BillLine;
}) {
  const api = useApi();
  const { t, number } = useI18n();
  const can = usePermissions();
  const [requesting, setRequesting] = useState(false);
  const free = useQuery({
    queryKey: ['free-elsewhere', line.variantId],
    queryFn: ({ signal }) => api.stock.freeElsewhere(line.variantId, signal),
    enabled: can('inventory:read'),
  });
  if (free.data === undefined) return null;
  const here = free.data.find((row) => row.store.id === storeId)?.available ?? 0;
  if (line.quantity <= here) return null;
  const sources = free.data.filter((row) => row.store.id !== storeId);
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
