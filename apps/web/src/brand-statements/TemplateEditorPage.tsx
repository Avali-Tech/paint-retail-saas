import {
  STATEMENT_AMOUNT_MODES,
  STATEMENT_DATE_FORMATS,
  STATEMENT_GRN_BASES,
  STATEMENT_SIGN_CONVENTIONS,
  TYPED_LINE_KINDS,
  type StatementTemplateView,
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
  useToast,
} from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import {
  NEW_TEMPLATE,
  readTemplate,
  templateValues,
  type TemplateField,
  type TemplateProblem,
  type TemplateValues,
} from './template-form.js';
import { templatesKey } from './TemplatesPage.js';

/** Fields with a range: only these are ever out of range. */
type RangeField = 'headerRowsToSkip' | 'dateWindowDays' | 'tolerance';

const RANGE: Readonly<Record<RangeField, MessageKey>> = {
  headerRowsToSkip: 'statements.editor.rangeRows',
  dateWindowDays: 'statements.editor.rangeDays',
  tolerance: 'statements.editor.rangeTolerance',
};

function TemplateForm({ template }: { readonly template: StatementTemplateView | null }) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<TemplateValues>(
    template === null ? NEW_TEMPLATE : templateValues(template),
  );
  const [problems, setProblems] = useState<Partial<Record<TemplateField, TemplateProblem>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const suppliers = useQuery({
    queryKey: ['suppliers', { limit: 100 }],
    queryFn: ({ signal }) => api.purchasing.suppliers({ limit: 100 }, signal),
  });
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api.catalog.brands() });

  const set = (changes: Partial<TemplateValues>) => {
    setValues((current) => ({ ...current, ...changes }));
  };
  const error = (field: TemplateField) => {
    const problem = problems[field];
    if (problem === undefined) return undefined;
    return t(problem === 'required' ? 'statements.editor.required' : RANGE[field as RangeField]);
  };
  const text = (field: keyof TemplateValues & TemplateField, labelKey: MessageKey) => (
    <Field label={t(labelKey)} error={error(field)}>
      <Input
        value={values[field]}
        onChange={(event) => {
          set({ [field]: event.target.value });
        }}
      />
    </Field>
  );
  const optionalText = (
    field: 'typeColumn' | 'referenceColumn' | 'descriptionColumn',
    labelKey: MessageKey,
  ) => (
    <Field label={t(labelKey)}>
      <Input
        value={values[field]}
        onChange={(event) => {
          set({ [field]: event.target.value });
        }}
      />
    </Field>
  );

  const save = async () => {
    const read = readTemplate(values);
    if (!read.ok) {
      setProblems(read.problems);
      return;
    }
    setProblems({});
    setMessage(null);
    setPending(true);
    try {
      await (template === null
        ? api.statements.createTemplate(read.input)
        : api.statements.updateTemplate(template.id, read.input));
      await queryClient.invalidateQueries({ queryKey: templatesKey });
      toast({ title: t('statements.editor.saved'), tone: 'success' });
      await navigate('/brand-statements/templates');
    } catch (failure) {
      setMessage(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      noValidate
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {message !== null && <Alert tone="danger">{message}</Alert>}
      <Card title={t('statements.editor.whose')}>
        <div className="form-grid">
          {text('name', 'statements.editor.name')}
          <Field label={t('statements.editor.supplier')} error={error('supplierPartyId')}>
            <Select
              value={values.supplierPartyId}
              disabled={template !== null}
              onChange={(event) => {
                set({ supplierPartyId: event.target.value });
              }}
            >
              <option value="">{t('statements.editor.chooseSupplier')}</option>
              {(suppliers.data?.items ?? []).map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('statements.editor.brand')}>
            <Select
              value={values.brandId}
              onChange={(event) => {
                set({ brandId: event.target.value });
              }}
            >
              <option value="">{t('statements.editor.noBrand')}</option>
              {(brands.data ?? []).map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>
      <Card title={t('statements.editor.columns')}>
        <div className="stack">
          <p className="muted">{t('statements.editor.hint')}</p>
          <div className="form-grid">
            <Field
              label={t('statements.editor.headerRowsToSkip')}
              hint={t('statements.editor.headerRowsHint')}
              error={error('headerRowsToSkip')}
            >
              <Input
                inputMode="numeric"
                value={values.headerRowsToSkip}
                onChange={(event) => {
                  set({ headerRowsToSkip: event.target.value });
                }}
              />
            </Field>
            {text('dateColumn', 'statements.editor.dateColumn')}
            <Field label={t('statements.editor.dateFormat')}>
              <Select
                value={values.dateFormat}
                onChange={(event) => {
                  set({ dateFormat: event.target.value as TemplateValues['dateFormat'] });
                }}
              >
                {STATEMENT_DATE_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {label('statementDateFormat', format)}
                  </option>
                ))}
              </Select>
            </Field>
            {text('documentColumn', 'statements.editor.documentColumn')}
            {optionalText('typeColumn', 'statements.editor.typeColumn')}
            {optionalText('referenceColumn', 'statements.editor.referenceColumn')}
            {optionalText('descriptionColumn', 'statements.editor.descriptionColumn')}
          </div>
        </div>
      </Card>
      <Card title={t('statements.editor.amounts')}>
        <div className="form-grid">
          <Field label={t('statements.editor.amountMode')}>
            <Select
              value={values.amountMode}
              onChange={(event) => {
                set({ amountMode: event.target.value as TemplateValues['amountMode'] });
              }}
            >
              {STATEMENT_AMOUNT_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {label('statementAmountMode', mode)}
                </option>
              ))}
            </Select>
          </Field>
          {values.amountMode === 'debit_credit' ? (
            <>
              {text('debitColumn', 'statements.editor.debitColumn')}
              {text('creditColumn', 'statements.editor.creditColumn')}
            </>
          ) : (
            <>
              {text('amountColumn', 'statements.editor.amountColumn')}
              <Field label={t('statements.editor.signConvention')}>
                <Select
                  value={values.signConvention}
                  onChange={(event) => {
                    set({
                      signConvention: event.target.value as TemplateValues['signConvention'],
                    });
                  }}
                >
                  {STATEMENT_SIGN_CONVENTIONS.map((sign) => (
                    <option key={sign} value={sign}>
                      {label('statementSignConvention', sign)}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
        </div>
      </Card>
      <Card title={t('statements.editor.kinds')}>
        <div className="stack">
          <p className="muted">{t('statements.editor.kindsHint')}</p>
          <div className="form-grid">
            {TYPED_LINE_KINDS.map((kind) => (
              <Field
                key={kind}
                label={t('statements.editor.words', { kind: label('statementLineKind', kind) })}
              >
                <Input
                  value={values.words[kind]}
                  onChange={(event) => {
                    set({ words: { ...values.words, [kind]: event.target.value } });
                  }}
                />
              </Field>
            ))}
          </div>
        </div>
      </Card>
      <Card title={t('statements.editor.matching')}>
        <div className="stack">
          <div className="form-grid">
            <Field label={t('statements.editor.dateWindowDays')} error={error('dateWindowDays')}>
              <Input
                inputMode="numeric"
                value={values.dateWindowDays}
                onChange={(event) => {
                  set({ dateWindowDays: event.target.value });
                }}
              />
            </Field>
            <Field
              label={t('statements.editor.tolerance')}
              hint={t('statements.editor.toleranceHint')}
              error={error('tolerance')}
            >
              <Input
                inputMode="decimal"
                value={values.tolerance}
                onChange={(event) => {
                  set({ tolerance: event.target.value });
                }}
              />
            </Field>
            <Field label={t('statements.editor.grnAmountBasis')}>
              <Select
                value={values.grnAmountBasis}
                onChange={(event) => {
                  set({ grnAmountBasis: event.target.value as TemplateValues['grnAmountBasis'] });
                }}
              >
                {STATEMENT_GRN_BASES.map((basis) => (
                  <option key={basis} value={basis}>
                    {label('statementGrnBasis', basis)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Checkbox
            label={t('statements.editor.active')}
            checked={values.isActive}
            onChange={(event) => {
              set({ isActive: event.target.checked });
            }}
          />
        </div>
      </Card>
      <div className="row row--end">
        <Button type="submit" loading={pending}>
          {t('statements.editor.save')}
        </Button>
      </div>
    </form>
  );
}

/** /brand-statements/templates/new */
export function NewTemplatePage() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('statements.editor.newTitle')} />
      <TemplateForm template={null} />
    </>
  );
}

/** /brand-statements/templates/:id/edit */
export function EditTemplatePage() {
  const api = useApi();
  const { t } = useI18n();
  const { id = '' } = useParams();
  const templates = useQuery({
    queryKey: templatesKey,
    queryFn: ({ signal }) => api.statements.templates(signal),
  });
  return (
    <>
      <PageHeader title={t('statements.editor.editTitle')} />
      <QueryState query={templates} error="statements.editor.error">
        {(rows) => {
          const template = rows.find((row) => row.id === id);
          return template === undefined ? (
            <Alert tone="danger">{t('statements.editor.error')}</Alert>
          ) : (
            <TemplateForm template={template} />
          );
        }}
      </QueryState>
    </>
  );
}
