import type { PriceHikePlanView } from '@paint/shared';
import { Alert, Button, Card, Field, Input, PageHeader, Select, Table } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { addDays, todayInIndia } from '../lib/india-time.js';
import { useStores } from '../stock/stores.js';
import { newPlan, readPlan } from './price-hike-form.js';

function Plan({ result }: { readonly result: PriceHikePlanView }) {
  const { t, money, number, plural } = useI18n();
  const { plan } = result;
  return (
    <Card title={t('priceHike.result', { brand: result.brand.name })}>
      <div className="stack">
        {plan.daysToHike <= 0 && <Alert tone="info">{t('priceHike.inForce')}</Alert>}
        {result.withoutCost > 0 && (
          <Alert tone="warning">{plural('priceHike.withoutCost', result.withoutCost)}</Alert>
        )}
        <dl className="scheme-figures">
          <div>
            <dt className="muted">{t('priceHike.stockUp')}</dt>
            <dd>{money(plan.stockUpPaise)}</dd>
          </div>
          <div>
            <dt className="muted">{t('priceHike.saving')}</dt>
            <dd>{money(plan.savingPaise)}</dd>
          </div>
          <div>
            <dt className="muted">{t('priceHike.carrying')}</dt>
            <dd>{money(plan.carryingCostPaise)}</dd>
          </div>
          <div>
            <dt className="muted">{t('priceHike.net')}</dt>
            <dd>
              <strong>{money(plan.netSavingPaise)}</strong>
            </dd>
          </div>
        </dl>
        <Table label={t('priceHike.table')}>
          <thead>
            <tr>
              <th scope="col">{t('priceHike.pack')}</th>
              <th scope="col">{t('priceHike.stock')}</th>
              <th scope="col">{t('priceHike.sold')}</th>
              <th scope="col">{t('priceHike.cost')}</th>
              <th scope="col">{t('priceHike.buy')}</th>
              <th scope="col">{t('priceHike.cash')}</th>
              <th scope="col">{t('priceHike.net')}</th>
            </tr>
          </thead>
          <tbody>
            {plan.lines.map((line, index) => {
              const sku = result.skus[index];
              return (
                <tr key={line.variantId}>
                  <th scope="row">
                    {sku?.productName} <span className="muted">{sku?.sku}</span>
                  </th>
                  <td>{number(Number(sku?.stockUnits))}</td>
                  <td>{number(Number(sku?.soldUnits))}</td>
                  <td>{money(Number(sku?.unitCostPaise))}</td>
                  <td>{number(line.stockUpUnits)}</td>
                  <td>{money(line.stockUpPaise)}</td>
                  <td>{money(line.netSavingPaise)}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}

/**
 * /brand-schemes/price-hike — when a brand announces a price rise, how much of each
 * pack is worth buying before it, against holding cost, cash tied up and dead-stock
 * risk ([PO-33]).
 */
export function PriceHikePage() {
  const api = useApi();
  const { t } = useI18n();
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api.catalog.brands() });
  const stores = useStores();
  const [values, setValues] = useState(() => newPlan(addDays(todayInIndia(), 7)));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PriceHikePlanView | null>(null);
  const text = (field: keyof typeof values) => ({
    value: values[field],
    onChange: (event: { target: { value: string } }) => {
      setValues((current) => ({ ...current, [field]: event.target.value }));
    },
  });
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const read = readPlan(values);
    if ('problem' in read) {
      setProblem(t(read.problem));
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      setResult(await api.schemes.plan(read.input));
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title={t('priceHike.title')} description={t('priceHike.description')} />
      <form className="stack" onSubmit={(event) => void submit(event)} noValidate>
        <Card>
          <div className="stack">
            <div className="form-grid">
              <Field label={t('schemes.brand')}>
                <Select {...text('brandId')}>
                  <option value="">{t('schemes.editor.chooseBrand')}</option>
                  {(brands.data ?? []).map((brand) => (
                    <option key={brand.id} value={brand.id}>
                      {brand.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('priceHike.store')}>
                <Select {...text('storeId')}>
                  <option value="">{t('priceHike.allStores')}</option>
                  {(stores.data ?? []).map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="form-grid">
              <Field label={t('priceHike.hike')}>
                <Input inputMode="decimal" {...text('hike')} />
              </Field>
              <Field label={t('priceHike.effectiveOn')}>
                <Input type="date" {...text('effectiveOn')} />
              </Field>
              <Field label={t('priceHike.window')}>
                <Input inputMode="numeric" {...text('window')} />
              </Field>
            </div>
            <div className="form-grid">
              <Field label={t('priceHike.holding')}>
                <Input inputMode="decimal" {...text('holding')} />
              </Field>
              <Field label={t('priceHike.money')}>
                <Input inputMode="decimal" {...text('money')} />
              </Field>
              <Field label={t('priceHike.deadStock')}>
                <Input inputMode="decimal" {...text('deadStock')} />
              </Field>
              <Field label={t('priceHike.cover')}>
                <Input inputMode="numeric" {...text('cover')} />
              </Field>
            </div>
            {problem !== null && <Alert tone="danger">{problem}</Alert>}
            <div className="row">
              <Button type="submit" loading={busy}>
                {t('priceHike.plan')}
              </Button>
            </div>
          </div>
        </Card>
      </form>
      {result !== null && <Plan result={result} />}
    </>
  );
}
