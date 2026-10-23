import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  useToast,
} from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { ProductPicker, picked, type PickedVariant } from '../lib/ProductPicker.js';
import { StoreSelect, storeLabel, useStoreAccess } from '../stock/StoreSelect.js';
import { useStoreDirectory } from '../stock/stores.js';
import { parsePositiveQuantity } from '../lib/quantity.js';
import { refreshInventory } from '../lib/refresh.js';

export interface RequestLine {
  readonly item: PickedVariant;
  readonly quantity: string;
}

/** Problems with a request before it is sent, by field ("from", "to", "lines", "line-<variantId>"). */
export function checkRequest(
  fromStoreId: string,
  toStoreId: string,
  lines: readonly RequestLine[],
): Record<string, MessageKey> {
  const problems: Record<string, MessageKey> = {};
  if (fromStoreId === '') problems.from = 'transfers.form.chooseStore';
  if (toStoreId === '') problems.to = 'transfers.form.chooseStore';
  else if (toStoreId === fromStoreId) problems.to = 'transfers.form.sameStore';
  if (lines.length === 0) problems.lines = 'workflow.noLines';
  for (const line of lines) {
    if (parsePositiveQuantity(line.quantity) === null) {
      problems[`line-${line.item.variantId}`] = 'transfers.form.quantityInvalid';
    }
  }
  return problems;
}

/** /transfers/new — a store the member works at asks another store for stock. */
export function NewTransferPage() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const access = useStoreAccess();
  // Stock can come from any open store of the business, not only the member's own.
  const directory = useStoreDirectory();
  // A link may start the request (e.g. from Slow movers): ?from=&to=&product=&variant=&quantity=
  const [params] = useSearchParams();
  const [fromStoreId, setFrom] = useState(params.get('from') ?? '');
  const [toStoreId, setTo] = useState(params.get('to') ?? '');
  const [note, setNote] = useState('');
  const productId = params.get('product');
  const product = useQuery({
    queryKey: ['product', productId],
    queryFn: ({ signal }) => api.catalog.product(String(productId), signal),
    enabled: productId !== null,
  });
  const linked = product.data?.variants.find((variant) => variant.id === params.get('variant'));
  // The linked product is the first line until the member changes the lines.
  const [edited, setEdited] = useState<RequestLine[] | null>(null);
  const lines: RequestLine[] =
    edited ??
    (product.data && linked
      ? [{ item: picked(product.data, linked), quantity: params.get('quantity') ?? '' }]
      : []);
  const setLines = (change: (current: RequestLine[]) => RequestLine[]) => {
    setEdited(change(lines));
  };
  const [problems, setProblems] = useState<Record<string, MessageKey>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const problem = (key: string) => {
    const found = problems[key];
    return found === undefined ? undefined : t(found);
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const found = checkRequest(fromStoreId, toStoreId, lines);
    // The API lets members request stock only for a store they work at.
    if (toStoreId !== '' && !access(toStoreId)) found.to = 'transfers.form.toHint';
    setProblems(found);
    setMessage(null);
    if (Object.keys(found).length > 0) return;
    setPending(true);
    try {
      const transfer = await api.transfers.create({
        fromStoreId,
        toStoreId,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
        lines: lines.map((line) => ({
          variantId: line.item.variantId,
          quantity: Number(parsePositiveQuantity(line.quantity)),
        })),
      });
      queryClient.setQueryData(['transfer', transfer.id], transfer);
      await refreshInventory(queryClient, ['transfer', transfer.id]);
      toast({ title: t('transfers.form.created', { number: transfer.number }), tone: 'success' });
      void navigate(`/transfers/${transfer.id}`);
    } catch (error) {
      setMessage(errorMessage(error));
      setPending(false);
    }
  };

  return (
    <>
      <PageHeader title={t('transfers.form.title')} description={t('transfers.form.description')} />
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {message !== null && <Alert tone="danger">{message}</Alert>}
        <Card>
          <div className="form-grid">
            <Field
              label={t('transfers.form.from')}
              hint={t('transfers.form.fromHint')}
              error={problem('from')}
              required
            >
              <Select
                value={fromStoreId}
                onChange={(event) => {
                  setFrom(event.target.value);
                }}
              >
                <option value="">{t('transfers.form.chooseStore')}</option>
                {(directory.data ?? [])
                  .filter((store) => store.id !== toStoreId)
                  .map((store) => (
                    <option key={store.id} value={store.id}>
                      {storeLabel(store)}
                    </option>
                  ))}
              </Select>
            </Field>
            <StoreSelect
              label={t('transfers.form.to')}
              value={toStoreId}
              onChange={setTo}
              emptyLabel={t('transfers.form.chooseStore')}
              error={problem('to')}
              exclude={fromStoreId}
              required
            />
          </div>
          <Field label={t('transfers.form.note')} className="form-wide">
            <Textarea
              maxLength={500}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </Field>
        </Card>
        <Card title={t('transfers.form.lines')}>
          <div className="stack">
            {problem('lines') !== undefined && <Alert tone="danger">{problem('lines')}</Alert>}
            {lines.length > 0 && (
              <ul className="doc-lines">
                {lines.map((line) => (
                  <li key={line.item.variantId} className="doc-line">
                    <div className="doc-line__head">
                      <span className="doc-line__title">
                        {line.item.sku} · {line.item.name}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setLines((current) =>
                            current.filter((item) => item.item.variantId !== line.item.variantId),
                          );
                        }}
                      >
                        {t('workflow.remove', { sku: line.item.sku })}
                      </Button>
                    </div>
                    <div className="doc-line__fields">
                      <Field
                        label={t('transfers.form.quantity', { sku: line.item.sku })}
                        error={problem(`line-${line.item.variantId}`)}
                      >
                        <Input
                          inputMode="decimal"
                          value={line.quantity}
                          onChange={(event) => {
                            const quantity = event.target.value;
                            setLines((current) =>
                              current.map((item) =>
                                item.item.variantId === line.item.variantId
                                  ? { ...item, quantity }
                                  : item,
                              ),
                            );
                          }}
                        />
                      </Field>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <ProductPicker
              chosen={new Set(lines.map((line) => line.item.variantId))}
              onChoose={(item) => {
                setLines((current) => [...current, { item, quantity: '' }]);
              }}
            />
          </div>
        </Card>
        <div className="row row--end">
          <Button type="submit" loading={pending}>
            {t('transfers.form.submit')}
          </Button>
        </div>
      </form>
    </>
  );
}
