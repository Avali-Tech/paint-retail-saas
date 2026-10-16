import type { EarnRuleView } from '@paint/shared';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  PageHeader,
  Select,
  Table,
  useToast,
} from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../app/services.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { QueryState } from '../lib/QueryState.js';
import { NEW_RULE, earnRuleValues, readEarnRule, type EarnRuleValues } from './earn-rule-form.js';

export const earnRulesKey = ['loyalty-earn-rules'] as const;

/** What a rule earns, in words: "2 points per ₹100 × 1.5". */
function useRuleText() {
  const { t, plural, money, number, date } = useI18n();
  return {
    rate: (rule: EarnRuleView) => {
      const points = plural('loyalty.pointsValue', rule.points);
      const base =
        rule.basis === 'value'
          ? t('earnRules.rateValue', { points, amount: money(Number(rule.perPaise)) })
          : t('earnRules.rateLitre', {
              points,
              litres: number(Number(rule.perMillilitres) / 1000),
            });
      return rule.multiplierBps === 10_000
        ? base
        : `${base} ${t('earnRules.times', { multiplier: number(rule.multiplierBps / 10_000) })}`;
    },
    dates: (rule: EarnRuleView) => {
      if (rule.validFrom !== null && rule.validUntil !== null) {
        return t('earnRules.between', { from: date(rule.validFrom), to: date(rule.validUntil) });
      }
      if (rule.validFrom !== null) return t('earnRules.fromDate', { date: date(rule.validFrom) });
      if (rule.validUntil !== null)
        return t('earnRules.untilDate', { date: date(rule.validUntil) });
      return t('earnRules.always');
    },
  };
}

/** Adds a rule (rule null) or changes one, in a dialog. */
function RuleDialog({
  rule,
  onClose,
}: {
  readonly rule: EarnRuleView | null;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api.catalog.brands() });
  const [values, setValues] = useState<EarnRuleValues>(
    rule === null ? NEW_RULE : earnRuleValues(rule),
  );
  const set = <K extends keyof EarnRuleValues>(key: K, value: EarnRuleValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };
  const text = (key: 'name' | 'points' | 'per' | 'multiplier' | 'validFrom' | 'validUntil') => ({
    value: values[key],
    onChange: (event: { target: { value: string } }) => {
      set(key, event.target.value);
    },
  });
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t(rule === null ? 'earnRules.addTitle' : 'earnRules.editTitle')}
      submitLabel={t('common.save')}
      onSubmit={async () => {
        const read = readEarnRule(values);
        if ('problem' in read) return t(read.problem);
        await (rule === null
          ? api.loyalty.createEarnRule(read.input)
          : api.loyalty.updateEarnRule(rule.id, read.input));
        await queryClient.invalidateQueries({ queryKey: earnRulesKey });
        toast({ title: t('earnRules.saved'), tone: 'success' });
        return undefined;
      }}
    >
      <Field label={t('earnRules.name')}>
        <Input {...text('name')} />
      </Field>
      <Field label={t('earnRules.basis')}>
        <Select
          value={values.basis}
          onChange={(event) => {
            set('basis', event.target.value === 'litre' ? 'litre' : 'value');
          }}
        >
          <option value="value">{t('earnRules.bases.value')}</option>
          <option value="litre">{t('earnRules.bases.litre')}</option>
        </Select>
      </Field>
      <div className="form-grid">
        <Field label={t('earnRules.points')}>
          <Input inputMode="numeric" {...text('points')} />
        </Field>
        <Field label={t(values.basis === 'value' ? 'earnRules.perRupees' : 'earnRules.perLitres')}>
          <Input inputMode="decimal" {...text('per')} />
        </Field>
      </div>
      <Field label={t('earnRules.brand')}>
        <Select
          value={values.brandId}
          onChange={(event) => {
            set('brandId', event.target.value);
          }}
        >
          <option value="">{t('earnRules.everyBrand')}</option>
          {(brands.data ?? []).map((brand) => (
            <option key={brand.id} value={brand.id}>
              {brand.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('earnRules.multiplier')} hint={t('earnRules.multiplierHint')}>
        <Input inputMode="decimal" {...text('multiplier')} />
      </Field>
      <div className="form-grid">
        <Field label={t('earnRules.validFrom')}>
          <Input type="date" {...text('validFrom')} />
        </Field>
        <Field label={t('earnRules.validUntil')}>
          <Input type="date" {...text('validUntil')} />
        </Field>
      </div>
      <Checkbox
        label={t('earnRules.active')}
        checked={values.isActive}
        onChange={(event) => {
          set('isActive', event.target.checked);
        }}
      />
    </FormDialog>
  );
}

function RulesTable({
  rules,
  editable,
  onEdit,
}: {
  readonly rules: readonly EarnRuleView[];
  readonly editable: boolean;
  readonly onEdit: (rule: EarnRuleView) => void;
}) {
  const { t } = useI18n();
  const text = useRuleText();
  if (rules.length === 0) return <p className="muted">{t('earnRules.empty')}</p>;
  return (
    <Table label={t('earnRules.title')}>
      <thead>
        <tr>
          <th scope="col">{t('earnRules.rule')}</th>
          <th scope="col">{t('earnRules.rate')}</th>
          <th scope="col">{t('earnRules.brand')}</th>
          <th scope="col">{t('earnRules.dates')}</th>
          <th scope="col">{t('earnRules.status')}</th>
          {editable && <th scope="col">{t('common.edit')}</th>}
        </tr>
      </thead>
      <tbody>
        {rules.map((rule) => (
          <tr key={rule.id}>
            <th scope="row">{rule.name}</th>
            <td>{text.rate(rule)}</td>
            <td>{rule.brand === null ? t('earnRules.everyBrand') : rule.brand.name}</td>
            <td>{text.dates(rule)}</td>
            <td>
              <Badge tone={rule.isActive ? 'success' : 'neutral'}>
                {t(rule.isActive ? 'earnRules.on' : 'earnRules.off')}
              </Badge>
            </td>
            {editable && (
              <td>
                <Button
                  variant="ghost"
                  aria-label={t('earnRules.editRule', { name: rule.name })}
                  onClick={() => {
                    onEdit(rule);
                  }}
                >
                  {t('common.edit')}
                </Button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** /settings/painter-points — how painters tagged on a bill earn points (P2-M36). */
export function EarnRulesPage() {
  const api = useApi();
  const { t } = useI18n();
  const manage = usePermissions()('loyalty:manage');
  const { allStores } = useCurrentProfile();
  const editable = manage && allStores;
  const rules = useQuery({
    queryKey: earnRulesKey,
    queryFn: ({ signal }) => api.loyalty.earnRules(signal),
  });
  // undefined: no dialog; null: a new rule.
  const [editing, setEditing] = useState<EarnRuleView | null | undefined>(undefined);
  return (
    <>
      <PageHeader
        title={t('earnRules.title')}
        description={t('earnRules.description')}
        {...(editable
          ? {
              actions: (
                <Button
                  onClick={() => {
                    setEditing(null);
                  }}
                >
                  {t('earnRules.add')}
                </Button>
              ),
            }
          : {})}
      />
      <div className="stack">
        {!editable && (
          <Alert tone="info">{t(manage ? 'earnRules.allStoresOnly' : 'earnRules.readOnly')}</Alert>
        )}
        <p className="muted">{t('earnRules.hint')}</p>
        <QueryState query={rules} error="earnRules.error">
          {(data) => <RulesTable rules={data} editable={editable} onEdit={setEditing} />}
        </QueryState>
      </div>
      {editing !== undefined && (
        <RuleDialog
          rule={editing}
          onClose={() => {
            setEditing(undefined);
          }}
        />
      )}
    </>
  );
}
