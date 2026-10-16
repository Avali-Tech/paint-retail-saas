import {
  SCHEME_DATE_BASES,
  SLAB_MEASURES,
  SLAB_MODES,
  productTitle,
  variantTitle,
} from '@paint/shared';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  useToast,
} from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import {
  NEW_BENEFIT,
  NEW_SCHEME,
  NEW_SLAB,
  readScheme,
  schemeValues,
  type BenefitKind,
  type BenefitValues,
  type SchemeValues,
  type SlabValues,
} from './scheme-form.js';
import { schemesKey } from './scheme-parts.js';

const BENEFIT_KINDS: readonly BenefitKind[] = ['rebate', 'per_litre', 'free_goods', 'points'];

/** The brand's products, for what the scheme covers and which pack it gives free. */
function useBrandProducts(brandId: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['products', { brandId, limit: 200 }],
    queryFn: ({ signal }) => api.catalog.products({ brandId, limit: 200 }, signal),
    enabled: brandId !== '',
  });
}

function BenefitFields({
  slab,
  index,
  value,
  packs,
  onChange,
  onRemove,
}: {
  readonly slab: number;
  readonly index: number;
  readonly value: BenefitValues;
  readonly packs: readonly { readonly id: string; readonly title: string }[];
  readonly onChange: (value: BenefitValues) => void;
  readonly onRemove: (() => void) | null;
}) {
  const { t, label } = useI18n();
  const text = (key: keyof BenefitValues) => ({
    value: value[key],
    onChange: (event: { target: { value: string } }) => {
      onChange({ ...value, [key]: event.target.value });
    },
  });
  const name = { slab: String(slab), benefit: String(index + 1) };
  return (
    <div className="scheme-benefit">
      <Field label={t('schemes.editor.benefitKind', name)}>
        <Select
          value={value.kind}
          onChange={(event) => {
            onChange({ ...value, kind: event.target.value as BenefitKind });
          }}
        >
          {BENEFIT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {label('schemeBenefitKind', kind)}
            </option>
          ))}
        </Select>
      </Field>
      {value.kind === 'rebate' && (
        <Field label={t('schemes.editor.percent', name)}>
          <Input inputMode="decimal" {...text('percent')} />
        </Field>
      )}
      {value.kind === 'per_litre' && (
        <Field label={t('schemes.editor.rupeesPerLitre', name)}>
          <Input inputMode="decimal" {...text('rupeesPerLitre')} />
        </Field>
      )}
      {value.kind === 'free_goods' && (
        <>
          <Field label={t('schemes.editor.pack', name)}>
            <Select {...text('variantId')}>
              <option value="">{t('schemes.editor.choosePack')}</option>
              {packs.map((pack) => (
                <option key={pack.id} value={pack.id}>
                  {pack.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('schemes.editor.units', name)}>
            <Input inputMode="numeric" {...text('units')} />
          </Field>
          <Field
            label={t('schemes.editor.perLitres', name)}
            hint={t('schemes.editor.perLitresHint')}
          >
            <Input inputMode="decimal" {...text('perLitres')} />
          </Field>
        </>
      )}
      {value.kind === 'points' && (
        <>
          <Field label={t('schemes.editor.label', name)}>
            <Input {...text('label')} />
          </Field>
          <Field label={t('schemes.editor.points', name)}>
            <Input inputMode="numeric" {...text('points')} />
          </Field>
        </>
      )}
      {onRemove !== null && (
        <Button variant="ghost" onClick={onRemove}>
          {t('schemes.editor.removeBenefit', name)}
        </Button>
      )}
    </div>
  );
}

function SlabFields({
  index,
  value,
  measure,
  packs,
  onChange,
  onRemove,
}: {
  readonly index: number;
  readonly value: SlabValues;
  readonly measure: SchemeValues['measure'];
  readonly packs: readonly { readonly id: string; readonly title: string }[];
  readonly onChange: (value: SlabValues) => void;
  readonly onRemove: (() => void) | null;
}) {
  const { t } = useI18n();
  const slab = index + 1;
  const setBenefit = (at: number, benefit: BenefitValues) => {
    onChange({ ...value, benefits: value.benefits.map((old, i) => (i === at ? benefit : old)) });
  };
  return (
    <fieldset className="scheme-slab">
      <legend>{t('schemes.editor.slab', { slab: String(slab) })}</legend>
      <Field
        label={t(
          measure === 'value' ? 'schemes.editor.targetRupees' : 'schemes.editor.targetLitres',
          { slab: String(slab) },
        )}
      >
        <Input
          inputMode="decimal"
          value={value.target}
          onChange={(event) => {
            onChange({ ...value, target: event.target.value });
          }}
        />
      </Field>
      {value.benefits.map((benefit, at) => (
        <BenefitFields
          key={at}
          slab={slab}
          index={at}
          value={benefit}
          packs={packs}
          onChange={(next) => {
            setBenefit(at, next);
          }}
          onRemove={
            value.benefits.length > 1
              ? () => {
                  onChange({ ...value, benefits: value.benefits.filter((_, i) => i !== at) });
                }
              : null
          }
        />
      ))}
      <div className="row">
        <Button
          variant="secondary"
          onClick={() => {
            onChange({ ...value, benefits: [...value.benefits, NEW_BENEFIT] });
          }}
        >
          {t('schemes.editor.addBenefit', { slab: String(slab) })}
        </Button>
        {onRemove !== null && (
          <Button variant="ghost" onClick={onRemove}>
            {t('schemes.editor.removeSlab', { slab: String(slab) })}
          </Button>
        )}
      </div>
    </fieldset>
  );
}

function SchemeForm({
  id,
  initial,
}: {
  readonly id: string | null;
  readonly initial: SchemeValues;
}) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api.catalog.brands() });
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.catalog.categories(),
  });
  const products = useBrandProducts(values.brandId);
  const productList = products.data?.items ?? [];
  const packs = productList.flatMap((product) =>
    product.variants.map((variant) => ({
      id: variant.id,
      title: variantTitle(product.brand.name, product.name, variant),
    })),
  );
  const set = <K extends keyof SchemeValues>(key: K, value: SchemeValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };
  const text = (
    key: 'name' | 'brandReference' | 'startsOn' | 'endsOn' | 'settlementDays' | 'note',
  ) => ({
    value: values[key],
    onChange: (event: { target: { value: string } }) => {
      set(key, event.target.value);
    },
  });
  const toggle = (key: 'productIds' | 'categoryIds', itemId: string, on: boolean) => {
    set(key, on ? [...values[key], itemId] : values[key].filter((other) => other !== itemId));
  };
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const read = readScheme(values);
    if ('problem' in read) {
      setProblem(t(read.problem));
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const saved = await (id === null
        ? api.schemes.create(read.input)
        : api.schemes.update(id, read.input));
      await queryClient.invalidateQueries({ queryKey: schemesKey });
      toast({ title: t('schemes.editor.saved'), tone: 'success' });
      await navigate(`/brand-schemes/${saved.id}`);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="stack" onSubmit={(event) => void submit(event)} noValidate>
      <Card title={t('schemes.editor.scheme')}>
        <div className="stack">
          <Field label={t('schemes.brand')}>
            <Select
              value={values.brandId}
              disabled={id !== null}
              onChange={(event) => {
                setValues((current) => ({
                  ...current,
                  brandId: event.target.value,
                  productIds: [],
                }));
              }}
            >
              <option value="">{t('schemes.editor.chooseBrand')}</option>
              {(brands.data ?? []).map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('schemes.editor.name')}>
            <Input {...text('name')} />
          </Field>
          <Field label={t('schemes.editor.brandReference')}>
            <Input {...text('brandReference')} />
          </Field>
          <div className="form-grid">
            <Field label={t('schemes.editor.startsOn')}>
              <Input type="date" {...text('startsOn')} />
            </Field>
            <Field label={t('schemes.editor.endsOn')}>
              <Input type="date" {...text('endsOn')} />
            </Field>
          </div>
          <div className="form-grid">
            <Field label={t('schemes.editor.measure')}>
              <Select
                value={values.measure}
                onChange={(event) => {
                  set('measure', event.target.value as SchemeValues['measure']);
                }}
              >
                {SLAB_MEASURES.map((measure) => (
                  <option key={measure} value={measure}>
                    {label('schemeMeasure', measure)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('schemes.editor.mode')} hint={t('schemes.editor.modeHint')}>
              <Select
                value={values.mode}
                onChange={(event) => {
                  set('mode', event.target.value as SchemeValues['mode']);
                }}
              >
                {SLAB_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {label('schemeMode', mode)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="form-grid">
            <Field
              label={t('schemes.editor.settlementDays')}
              hint={t('schemes.editor.settlementHint')}
            >
              <Input inputMode="numeric" {...text('settlementDays')} />
            </Field>
            <Field label={t('schemes.editor.dateBasis')} hint={t('schemes.editor.dateBasisHint')}>
              <Select
                value={values.dateBasis}
                onChange={(event) => {
                  set('dateBasis', event.target.value as SchemeValues['dateBasis']);
                }}
              >
                {SCHEME_DATE_BASES.map((basis) => (
                  <option key={basis} value={basis}>
                    {label('schemeDateBasis', basis)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t('schemes.editor.note')}>
            <Textarea {...text('note')} />
          </Field>
        </div>
      </Card>
      <Card title={t('schemes.editor.covers')}>
        <div className="stack">
          <p className="muted">{t('schemes.editor.coversHint')}</p>
          <fieldset className="stack">
            <legend>{t('schemes.editor.products')}</legend>
            <div className="scheme-choices">
              {productList.map((product) => (
                <Checkbox
                  key={product.id}
                  label={productTitle(product.brand.name, product.name)}
                  checked={values.productIds.includes(product.id)}
                  onChange={(event) => {
                    toggle('productIds', product.id, event.target.checked);
                  }}
                />
              ))}
            </div>
          </fieldset>
          <fieldset className="stack">
            <legend>{t('schemes.editor.categories')}</legend>
            <div className="scheme-choices">
              {(categories.data ?? []).map((category) => (
                <Checkbox
                  key={category.id}
                  label={category.name}
                  checked={values.categoryIds.includes(category.id)}
                  onChange={(event) => {
                    toggle('categoryIds', category.id, event.target.checked);
                  }}
                />
              ))}
            </div>
          </fieldset>
        </div>
      </Card>
      <Card title={t('schemes.editor.slabs')}>
        <div className="stack">
          {values.slabs.map((slab, index) => (
            <SlabFields
              key={index}
              index={index}
              value={slab}
              measure={values.measure}
              packs={packs}
              onChange={(next) => {
                set(
                  'slabs',
                  values.slabs.map((old, i) => (i === index ? next : old)),
                );
              }}
              onRemove={
                values.slabs.length > 1
                  ? () => {
                      set(
                        'slabs',
                        values.slabs.filter((_, i) => i !== index),
                      );
                    }
                  : null
              }
            />
          ))}
          <div className="row">
            <Button
              variant="secondary"
              onClick={() => {
                set('slabs', [...values.slabs, NEW_SLAB]);
              }}
            >
              {t('schemes.editor.addSlab')}
            </Button>
          </div>
        </div>
      </Card>
      {problem !== null && <Alert tone="danger">{problem}</Alert>}
      <div className="row">
        <Button type="submit" loading={saving}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/** /brand-schemes/new — a brand's scheme with its slabs and what each gives. */
export function NewSchemePage() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('schemes.editor.newTitle')} description={t('schemes.editor.hint')} />
      <SchemeForm id={null} initial={NEW_SCHEME} />
    </>
  );
}

/** /brand-schemes/:id/edit — corrects a draft or running scheme. */
export function EditSchemePage() {
  const api = useApi();
  const { t } = useI18n();
  const { id = '' } = useParams();
  const detail = useQuery({
    queryKey: [...schemesKey, id],
    queryFn: ({ signal }) => api.schemes.detail(id, signal),
  });
  return (
    <>
      <PageHeader title={t('schemes.editor.editTitle')} description={t('schemes.editor.hint')} />
      <QueryState query={detail} error="schemes.detailError">
        {(data) => <SchemeForm id={id} initial={schemeValues(data.scheme)} />}
      </QueryState>
    </>
  );
}
