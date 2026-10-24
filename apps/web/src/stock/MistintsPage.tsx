import { MISTINT_STATUSES, type MistintStatus, type MistintView } from '@paint/shared';
import {
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Pagination,
  Select,
  Table,
  Textarea,
  buttonStyle,
  useToast,
} from '@paint/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { useUrlFilters } from '../lib/hooks.js';
import { ProductPicker, type PickedVariant } from '../lib/ProductPicker.js';
import { productTitle, variantName } from '../lib/product-title.js';
import { QueryState } from '../lib/QueryState.js';
import { parsePositiveQuantity } from '../lib/quantity.js';
import { SectionNav } from '../lib/SectionNav.js';
import { STOCK_SECTIONS } from './sections.js';
import { StoreSelect, storeLabel, useStoreAccess } from './StoreSelect.js';
import { useStoreDirectory } from './stores.js';

export const PAGE_SIZE = 50;
const MISTINTS_KEY = ['mistints'] as const;

const statusOf = (value: string): MistintStatus =>
  (MISTINT_STATUSES as readonly string[]).includes(value) ? (value as MistintStatus) : 'available';

/** Records a can tinted to the wrong shade: it leaves sellable stock at once. */
function RecordDialog({ onClose }: { readonly onClose: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [storeId, setStore] = useState('');
  const [item, setItem] = useState<PickedVariant | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [shadeCode, setShadeCode] = useState('');
  const [shadeName, setShadeName] = useState('');
  const [intendedShade, setIntended] = useState('');
  const [reason, setReason] = useState('');
  const optional = (text: string) => (text.trim() === '' ? undefined : text.trim());
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('stock.mistints.recordTitle')}
      description={t('stock.mistints.recordDescription')}
      submitLabel={t('stock.mistints.record')}
      onSubmit={async () => {
        const amount = parsePositiveQuantity(quantity);
        if (storeId === '' || item === null || amount === null) {
          return t('stock.mistints.recordIncomplete');
        }
        if (shadeCode.trim() === '' || reason.trim().length < 2) {
          return t('stock.mistints.recordIncomplete');
        }
        const can = await api.mistints.record({
          storeId,
          variantId: item.variantId,
          quantity: amount,
          shadeCode: shadeCode.trim(),
          shadeName: optional(shadeName),
          intendedShade: optional(intendedShade),
          reason: reason.trim(),
        });
        await queryClient.invalidateQueries({ queryKey: MISTINTS_KEY });
        toast({ title: t('stock.mistints.recorded', { sku: can.variant.sku }), tone: 'success' });
        return undefined;
      }}
    >
      <StoreSelect
        label={t('stock.store')}
        emptyLabel={t('stock.mistints.chooseStore')}
        value={storeId}
        onChange={setStore}
      />
      {item === null ? (
        <ProductPicker
          chosen={new Set()}
          onChoose={(picked) => {
            setItem(picked);
          }}
        />
      ) : (
        <p>
          {item.sku} · {item.name}{' '}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setItem(null);
            }}
          >
            {t('stock.mistints.change')}
          </Button>
        </p>
      )}
      <Field label={t('stock.mistints.quantity')}>
        <Input
          inputMode="decimal"
          value={quantity}
          onChange={(event) => {
            setQuantity(event.target.value);
          }}
        />
      </Field>
      <Field label={t('stock.mistints.shadeCode')} hint={t('stock.mistints.shadeCodeHint')}>
        <Input
          value={shadeCode}
          onChange={(event) => {
            setShadeCode(event.target.value);
          }}
        />
      </Field>
      <Field label={t('stock.mistints.shadeName')}>
        <Input
          value={shadeName}
          onChange={(event) => {
            setShadeName(event.target.value);
          }}
        />
      </Field>
      <Field label={t('stock.mistints.intendedShade')}>
        <Input
          value={intendedShade}
          onChange={(event) => {
            setIntended(event.target.value);
          }}
        />
      </Field>
      <Field label={t('stock.mistints.reason')} hint={t('stock.mistints.reasonHint')}>
        <Textarea
          rows={2}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

/** Writes off a can nobody will buy; its cost is the loss. */
function WriteOffDialog({
  can,
  onClose,
}: {
  readonly can: MistintView;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('stock.mistints.writeOffTitle', { sku: can.variant.sku })}
      description={t('stock.mistints.writeOffDescription')}
      submitLabel={t('stock.mistints.writeOff')}
      onSubmit={async () => {
        if (note.trim().length < 2) return t('stock.mistints.noteRequired');
        await api.mistints.writeOff(can.id, note.trim());
        await queryClient.invalidateQueries({ queryKey: MISTINTS_KEY });
        toast({ title: t('stock.mistints.writtenOff', { sku: can.variant.sku }), tone: 'success' });
        return undefined;
      }}
    >
      <Field label={t('stock.mistints.note')}>
        <Textarea
          rows={2}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

/**
 * /stock/mistints — cans tinted to the wrong shade, at every branch: waiting to
 * be sold at a discount (any branch can sell its own), sold, or written off.
 */
export function MistintsPage() {
  const api = useApi();
  const { t, number, money, date, label } = useI18n();
  const can = usePermissions();
  const access = useStoreAccess();
  const directory = useStoreDirectory();
  const [recording, setRecording] = useState(false);
  const [writingOff, setWritingOff] = useState<MistintView | null>(null);
  const filters = useUrlFilters(['status', 'store'] as const);
  const status = statusOf(filters.values.status);
  const { store } = filters.values;
  const costs = can('costs:read');
  const cans = useQuery({
    queryKey: [...MISTINTS_KEY, status, store, filters.offset],
    queryFn: ({ signal }) =>
      api.mistints.list(
        { status, storeId: store || undefined, limit: PAGE_SIZE, offset: filters.offset },
        signal,
      ),
    placeholderData: keepPreviousData,
  });
  const mayRecord = can('billing:issue') || can('inventory:manage');

  return (
    <>
      <PageHeader
        title={t('stock.mistints.title')}
        description={t('stock.mistints.description')}
        actions={
          mayRecord && (
            <Button
              onClick={() => {
                setRecording(true);
              }}
            >
              {t('stock.mistints.add')}
            </Button>
          )
        }
      />
      <SectionNav label="stock.sections.label" links={STOCK_SECTIONS} />
      <Card>
        <div className="filters">
          <Field label={t('stock.mistints.status')}>
            <Select
              value={status}
              onChange={(event) => {
                filters.set('status', event.target.value === 'available' ? '' : event.target.value);
              }}
            >
              {MISTINT_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {label('mistintStatus', option)}
                </option>
              ))}
            </Select>
          </Field>
          {/* Every branch's cans: any of them can sell its own at a discount. */}
          <Field label={t('stock.store')}>
            <Select
              value={store}
              onChange={(event) => {
                filters.set('store', event.target.value);
              }}
            >
              <option value="">{t('stock.allStores')}</option>
              {(directory.data ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {storeLabel(entry)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <QueryState query={cans} error="stock.mistints.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="check" size={32} />}
                title={t('stock.mistints.emptyTitle')}
                description={t('stock.mistints.emptyDescription')}
              />
            ) : (
              <>
                <Table label={t('stock.mistints.list')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('stock.product')}</th>
                      <th scope="col">{t('stock.store')}</th>
                      <th scope="col" className="ui-num">
                        {t('stock.mistints.quantity')}
                      </th>
                      <th scope="col">{t('stock.mistints.shade')}</th>
                      <th scope="col">{t('stock.mistints.why')}</th>
                      {costs && (
                        <th scope="col" className="ui-num">
                          {t('stock.mistints.cost')}
                        </th>
                      )}
                      {costs && status !== 'available' && (
                        <th scope="col" className="ui-num">
                          {t('stock.mistints.loss')}
                        </th>
                      )}
                      <th scope="col">
                        <span className="visually-hidden">{t('stock.mistints.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((item) => {
                      const here = access(item.store.id);
                      return (
                        <tr key={item.id}>
                          <th scope="row">
                            {productTitle(item.brand.name, item.product.name)}
                            <span className="cell-meta">
                              {item.variant.sku} · {variantName(item.variant)}
                            </span>
                          </th>
                          <td>{item.store.code}</td>
                          <td className="ui-num">{number(item.quantity)}</td>
                          <td>
                            {item.shadeName === null
                              ? item.shadeCode
                              : `${item.shadeCode} · ${item.shadeName}`}
                            {item.intendedShade !== null && (
                              <span className="cell-meta">
                                {t('stock.mistints.wanted', { shade: item.intendedShade })}
                              </span>
                            )}
                          </td>
                          <td>
                            {item.note ?? item.reason}
                            <span className="cell-meta">
                              {item.createdBy} · {date(item.createdAt)}
                              {item.invoice !== null && (
                                <>
                                  {' · '}
                                  <Link to={`/invoices/${item.invoice.id}`}>
                                    {item.invoice.number}
                                  </Link>
                                </>
                              )}
                            </span>
                          </td>
                          {costs && (
                            <td className="ui-num">
                              {item.costPaise === null ? t('common.none') : money(item.costPaise)}
                            </td>
                          )}
                          {costs && status !== 'available' && (
                            <td className="ui-num">
                              {item.lossPaise === null ? t('common.none') : money(item.lossPaise)}
                            </td>
                          )}
                          <td>
                            {item.status === 'available' && here && can('billing:issue') && (
                              <Link
                                to={`/pos?mistint=${item.id}`}
                                {...buttonStyle('secondary', 'sm')}
                              >
                                {t('stock.mistints.sell')}
                              </Link>
                            )}{' '}
                            {item.status === 'available' && here && can('inventory:manage') && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setWritingOff(item);
                                }}
                              >
                                {t('stock.mistints.writeOff')}
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('stock.mistints.pages')}
                  range={(from, to, total) => t('common.range', { from, to, total })}
                  previousLabel={t('common.previous')}
                  nextLabel={t('common.next')}
                />
              </>
            )
          }
        </QueryState>
      </Card>
      {recording && (
        <RecordDialog
          onClose={() => {
            setRecording(false);
          }}
        />
      )}
      {writingOff !== null && (
        <WriteOffDialog
          can={writingOff}
          onClose={() => {
            setWritingOff(null);
          }}
        />
      )}
    </>
  );
}
