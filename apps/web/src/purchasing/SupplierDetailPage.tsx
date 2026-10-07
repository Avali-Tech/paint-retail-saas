import { Button, Card, Field, Input, PageHeader, Table, buttonStyle, useToast } from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Supplier } from '../api/purchasing.js';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { optional } from '../lib/inputs.js';
import { ProductPicker, type PickedVariant } from '../lib/ProductPicker.js';
import { QueryState } from '../lib/QueryState.js';
import { useDays, useSupplier } from './shared.js';
import { variantTitle } from '../lib/product-title.js';

/** "" -> null; "12" -> 12; anything else (or outside 0–365) -> undefined. */
export function parseDays(text: string): number | null | undefined {
  const value = text.trim();
  if (value === '') return null;
  if (!/^\d{1,3}$/.test(value)) return undefined;
  const days = Number(value);
  return days <= 365 ? days : undefined;
}

function TermsDialog({
  supplier,
  onClose,
}: {
  readonly supplier: Supplier;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [terms, setTerms] = useState(String(supplier.paymentTermsDays));
  const [lead, setLead] = useState(
    supplier.leadTimeDays === null ? '' : String(supplier.leadTimeDays),
  );
  const [problems, setProblems] = useState<{ terms?: string; lead?: string }>({});
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('purchasing.supplierDetail.termsTitle')}
      submitLabel={t('common.save')}
      onSubmit={async () => {
        const paymentTermsDays = parseDays(terms);
        const leadTimeDays = parseDays(lead);
        const invalid = t('purchasing.supplierDetail.daysInvalid');
        const found = {
          ...(paymentTermsDays === null || paymentTermsDays === undefined
            ? { terms: invalid }
            : {}),
          ...(leadTimeDays === undefined ? { lead: invalid } : {}),
        };
        setProblems(found);
        if (
          paymentTermsDays === null ||
          paymentTermsDays === undefined ||
          leadTimeDays === undefined
        ) {
          return false;
        }
        const saved = await api.purchasing.saveSupplierProfile(supplier.id, {
          paymentTermsDays,
          leadTimeDays,
        });
        queryClient.setQueryData(['supplier', supplier.id], saved);
        await queryClient.invalidateQueries({ queryKey: ['suppliers'] });
        toast({ title: t('purchasing.supplierDetail.termsSaved'), tone: 'success' });
        return undefined;
      }}
    >
      <Field
        label={t('purchasing.supplierDetail.termsDays')}
        hint={t('purchasing.supplierDetail.termsHint')}
        error={problems.terms}
        required
      >
        <Input
          inputMode="numeric"
          value={terms}
          onChange={(event) => {
            setTerms(event.target.value);
          }}
        />
      </Field>
      <Field
        label={t('purchasing.supplierDetail.leadDays')}
        hint={t('purchasing.supplierDetail.leadHint')}
        error={problems.lead}
      >
        <Input
          inputMode="numeric"
          value={lead}
          onChange={(event) => {
            setLead(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

/** Changes the supplier's own code for a product already linked (blank clears it). */
function SupplierCodeDialog({
  supplier,
  product,
  onClose,
}: {
  readonly supplier: Supplier;
  readonly product: Supplier['products'][number];
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [code, setCode] = useState(product.supplierSku ?? '');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('purchasing.supplierDetail.codeTitle', { sku: product.sku })}
      submitLabel={t('common.save')}
      onSubmit={async () => {
        const saved = await api.purchasing.saveSupplierProducts(supplier.id, [
          { variantId: product.variantId, supplierSku: optional(code) },
        ]);
        queryClient.setQueryData(['supplier', supplier.id], saved);
        toast({ title: t('purchasing.supplierDetail.productsSaved'), tone: 'success' });
        return undefined;
      }}
    >
      <Field label={t('purchasing.supplierDetail.supplierSkuOf', { sku: product.sku })}>
        <Input
          autoComplete="off"
          maxLength={64}
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

interface PendingProduct {
  readonly variantId: string;
  readonly sku: string;
  readonly name: string;
  supplierSku: string;
}

/** Links more products to the supplier, each with the supplier's own code. */
function AddProducts({ supplier }: { readonly supplier: Supplier }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingProduct[]>([]);
  const [saving, setSaving] = useState(false);
  const chosen = new Set([
    ...supplier.products.map((product) => product.variantId),
    ...pending.map((product) => product.variantId),
  ]);
  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.purchasing.saveSupplierProducts(
        supplier.id,
        pending.map((product) => ({
          variantId: product.variantId,
          supplierSku: optional(product.supplierSku),
        })),
      );
      queryClient.setQueryData(['supplier', supplier.id], saved);
      await queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      setPending([]);
      toast({ title: t('purchasing.supplierDetail.productsSaved'), tone: 'success' });
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="stack">
      {pending.length > 0 && (
        <ul className="doc-lines">
          {pending.map((product) => (
            <li key={product.variantId} className="doc-line">
              <div className="doc-line__head">
                <span className="doc-line__title">
                  {product.sku} · {product.name}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPending((current) =>
                      current.filter((item) => item.variantId !== product.variantId),
                    );
                  }}
                >
                  {t('workflow.remove', { sku: product.sku })}
                </Button>
              </div>
              <Field label={t('purchasing.supplierDetail.supplierSkuOf', { sku: product.sku })}>
                <Input
                  maxLength={64}
                  value={product.supplierSku}
                  onChange={(event) => {
                    const value = event.target.value;
                    setPending((current) =>
                      current.map((item) =>
                        item.variantId === product.variantId
                          ? { ...item, supplierSku: value }
                          : item,
                      ),
                    );
                  }}
                />
              </Field>
            </li>
          ))}
        </ul>
      )}
      <ProductPicker
        chosen={chosen}
        onChoose={(picked: PickedVariant) => {
          setPending((current) => [
            ...current,
            { variantId: picked.variantId, sku: picked.sku, name: picked.name, supplierSku: '' },
          ]);
        }}
      />
      {pending.length > 0 && (
        <div className="row row--end">
          <Button
            loading={saving}
            onClick={() => {
              void save();
            }}
          >
            {t('purchasing.supplierDetail.saveProducts')}
          </Button>
        </div>
      )}
    </div>
  );
}

function SupplierView({ supplier }: { readonly supplier: Supplier }) {
  const api = useApi();
  const { t, money, date } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const can = usePermissions();
  const manage = can('purchasing:manage');
  const days = useDays();
  const [editing, setEditing] = useState(false);
  const [coding, setCoding] = useState<Supplier['products'][number] | null>(null);

  const remove = async (variantId: string, sku: string) => {
    try {
      await api.purchasing.removeSupplierProduct(supplier.id, variantId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['supplier', supplier.id] }),
        queryClient.invalidateQueries({ queryKey: ['suppliers'] }),
      ]);
      toast({ title: t('purchasing.supplierDetail.removed', { sku }), tone: 'success' });
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' });
    }
  };

  return (
    <>
      <PageHeader
        title={supplier.name}
        actions={
          manage ? (
            <Link to={`/purchase-orders/new?supplier=${supplier.id}`} {...buttonStyle('secondary')}>
              {t('purchasing.supplierDetail.newOrder')}
            </Link>
          ) : undefined
        }
      />
      <div className="stack">
        <Card
          title={t('purchasing.supplierDetail.details')}
          actions={
            manage ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setEditing(true);
                }}
              >
                {t('purchasing.supplierDetail.editTerms')}
              </Button>
            ) : undefined
          }
        >
          <dl className="facts">
            <div>
              <dt>{t('purchasing.supplierDetail.terms')}</dt>
              <dd>{days.terms(supplier.paymentTermsDays)}</dd>
            </div>
            <div>
              <dt>{t('purchasing.supplierDetail.leadTime')}</dt>
              <dd>{days.days(supplier.leadTimeDays)}</dd>
            </div>
            <div>
              <dt>{t('purchasing.supplierDetail.phone')}</dt>
              <dd>{supplier.phone ?? t('common.none')}</dd>
            </div>
            <div>
              <dt>{t('purchasing.supplierDetail.gstin')}</dt>
              <dd>{supplier.gstin ?? t('common.none')}</dd>
            </div>
          </dl>
        </Card>
        <Card title={t('purchasing.supplierDetail.products')}>
          <div className="stack">
            {supplier.products.length === 0 ? (
              <p className="muted">{t('purchasing.supplierDetail.noProducts')}</p>
            ) : (
              <Table label={t('purchasing.supplierDetail.products')}>
                <thead>
                  <tr>
                    <th scope="col">{t('purchasing.supplierDetail.sku')}</th>
                    <th scope="col">{t('purchasing.product')}</th>
                    <th scope="col">{t('purchasing.supplierDetail.supplierSku')}</th>
                    <th scope="col" className="ui-num">
                      {t('purchasing.supplierDetail.lastCost')}
                    </th>
                    <th scope="col">{t('purchasing.supplierDetail.lastReceived')}</th>
                    {manage && (
                      <th scope="col">
                        <span className="ui-visually-hidden">
                          {t('purchasing.supplierDetail.actions')}
                        </span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {supplier.products.map((product) => (
                    <tr key={product.variantId}>
                      <th scope="row">{product.sku}</th>
                      <td>{variantTitle(product.brandName, product.productName, product)}</td>
                      <td>{product.supplierSku ?? t('common.none')}</td>
                      <td className="ui-num">
                        {product.lastCostPaise === null
                          ? t('common.none')
                          : money(product.lastCostPaise)}
                      </td>
                      <td>
                        {product.lastReceivedAt === null
                          ? t('common.none')
                          : date(product.lastReceivedAt)}
                      </td>
                      {manage && (
                        <td>
                          <span className="row">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setCoding(product);
                              }}
                            >
                              {t('purchasing.supplierDetail.editCode', { sku: product.sku })}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                void remove(product.variantId, product.sku);
                              }}
                            >
                              {t('purchasing.supplierDetail.remove', { sku: product.sku })}
                            </Button>
                          </span>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {manage && (
              <section className="stack" aria-labelledby="supplier-add-products">
                <h3 id="supplier-add-products" className="subheading">
                  {t('purchasing.supplierDetail.addProducts')}
                </h3>
                <AddProducts supplier={supplier} />
              </section>
            )}
          </div>
        </Card>
      </div>
      {coding !== null && (
        <SupplierCodeDialog
          supplier={supplier}
          product={coding}
          onClose={() => {
            setCoding(null);
          }}
        />
      )}
      {editing && (
        <TermsDialog
          supplier={supplier}
          onClose={() => {
            setEditing(false);
          }}
        />
      )}
    </>
  );
}

/** /suppliers/:id */
export function SupplierDetailPage() {
  const id = String(useParams().id);
  const supplier = useSupplier(id);
  return (
    <QueryState query={supplier} error="purchasing.supplierDetail.error">
      {(data) => <SupplierView supplier={data} />}
    </QueryState>
  );
}
