import {
  basisPointsToPercent,
  GST_REGISTRATION_TYPES,
  CURRENT_GST_STATES,
  isValidGstin,
  isValidPincode,
  percentToBasisPoints,
  stateCodeFromGstin,
  type GstRegistrations,
  type GstRegistrationType,
  type StoreGstRegistration,
  type TaxCategoryView,
} from '@paint/shared';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/errors.js';
import { TAX_OPTIONS_KEY } from '../api/tax.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { stateLabel } from '../lib/gst-states.js';
import { todayInIndia } from '../lib/india-time.js';
import { QueryState } from '../lib/QueryState.js';
import '../styles/tax.css';

export const REGISTRATIONS_KEY = ['gst-registrations'] as const;
export const TAX_CATEGORIES_KEY = ['tax-categories'] as const;

const RATE = /^\d{1,3}(\.\d{1,2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A rate typed in percent, as basis points; null when it is not a rate from 0 to 100. */
export function parseRate(text: string): number | null {
  const value = text.trim();
  if (!RATE.test(value) || Number(value) > 100) return null;
  return percentToBasisPoints(Number(value));
}

/** The business's legal name (the default on registrations) and its PAN. */
function BusinessCard({
  registrations,
  manage,
}: {
  readonly registrations: GstRegistrations;
  readonly manage: boolean;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [legalName, setLegalName] = useState(registrations.legalName ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const save = async () => {
    setPending(true);
    setMessage(null);
    try {
      const saved = await api.tax.setBusiness(legalName.trim() === '' ? null : legalName.trim());
      queryClient.setQueryData(REGISTRATIONS_KEY, saved);
      toast({ title: t('taxSettings.business.saved'), tone: 'success' });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <Card title={t('taxSettings.business.title')}>
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {message !== null && <Alert tone="danger">{message}</Alert>}
        <fieldset className="plain-fieldset form-grid" disabled={!manage}>
          <Field
            label={t('taxSettings.business.legalName')}
            hint={t('taxSettings.business.legalNameHint')}
          >
            <Input
              value={legalName}
              maxLength={160}
              onChange={(event) => {
                setLegalName(event.target.value);
              }}
            />
          </Field>
          <Field label={t('taxSettings.business.pan')}>
            <Input readOnly value={registrations.pan ?? t('taxSettings.business.panNone')} />
          </Field>
        </fieldset>
        {manage && (
          <div className="row row--end">
            <Button type="submit" variant="secondary" loading={pending}>
              {t('taxSettings.business.save')}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

interface RegistrationDraft {
  registrationType: GstRegistrationType;
  stateCode: string;
  gstin: string;
  legalName: string;
  tradeName: string;
  addressLine: string;
  city: string;
  pincode: string;
}

const draftOf = (store: StoreGstRegistration): RegistrationDraft => ({
  registrationType: store.registrationType,
  stateCode: store.stateCode ?? '',
  gstin: store.gstin ?? '',
  legalName: store.legalName ?? '',
  tradeName: store.tradeName ?? '',
  addressLine: store.addressLine ?? '',
  city: store.city ?? '',
  pincode: store.pincode ?? '',
});

/** Edits one store's registration; checks what it can before asking the API. */
function RegistrationDialog({
  store,
  onClose,
}: {
  readonly store: StoreGstRegistration;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => draftOf(store));
  const registered = draft.registrationType !== 'unregistered';
  const gstin = draft.gstin.trim().toUpperCase();
  const set = (field: keyof RegistrationDraft) => (value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };
  const problem = () => {
    if (draft.stateCode === '') return t('taxSettings.stores.stateRequired');
    if (registered && gstin === '') return t('taxSettings.stores.gstinRequired');
    if (registered && !isValidGstin(gstin)) return t('taxSettings.stores.gstinInvalid');
    if (registered && stateCodeFromGstin(gstin) !== draft.stateCode) {
      return t('taxSettings.stores.gstinOtherState');
    }
    if (draft.pincode.trim() !== '' && !isValidPincode(draft.pincode.trim())) {
      return t('taxSettings.stores.pincodeInvalid');
    }
    return null;
  };
  const submit = async () => {
    const found = problem();
    if (found !== null) return found;
    // Blank fields are left out (and cleared).
    const pick = (field: 'legalName' | 'tradeName' | 'addressLine' | 'city' | 'pincode') =>
      draft[field].trim() === '' ? {} : { [field]: draft[field].trim() };
    const saved = await api.tax.setStore(store.storeId, {
      registrationType: draft.registrationType,
      stateCode: draft.stateCode,
      ...(registered ? { gstin, ...pick('legalName'), ...pick('tradeName') } : {}),
      ...pick('addressLine'),
      ...pick('city'),
      ...pick('pincode'),
    });
    queryClient.setQueryData(REGISTRATIONS_KEY, saved);
    await queryClient.invalidateQueries({ queryKey: TAX_OPTIONS_KEY });
    toast({ title: t('taxSettings.stores.saved'), tone: 'success' });
    return undefined;
  };
  const text = (field: keyof RegistrationDraft, labelKey: MessageKey) => (
    <Field label={t(labelKey)}>
      <Input
        value={draft[field]}
        onChange={(event) => {
          set(field)(event.target.value);
        }}
      />
    </Field>
  );
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('taxSettings.stores.dialogTitle', { name: `${store.code} · ${store.name}` })}
      submitLabel={t('taxSettings.stores.save')}
      onSubmit={submit}
    >
      <div className="form-grid">
        <Field label={t('taxSettings.stores.type')}>
          <Select
            value={draft.registrationType}
            onChange={(event) => {
              set('registrationType')(event.target.value);
            }}
          >
            {GST_REGISTRATION_TYPES.map((type) => (
              <option key={type} value={type}>
                {label('gstRegistrationTypes', type)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('taxSettings.stores.state')} required>
          <Select
            value={draft.stateCode}
            onChange={(event) => {
              set('stateCode')(event.target.value);
            }}
          >
            <option value="">{t('taxSettings.stores.chooseState')}</option>
            {CURRENT_GST_STATES.map((state) => (
              <option key={state.code} value={state.code}>
                {stateLabel(state.code)}
              </option>
            ))}
          </Select>
        </Field>
        {registered && (
          <>
            <Field label={t('taxSettings.stores.gstin')} required>
              <Input
                className="uppercase"
                maxLength={15}
                autoComplete="off"
                value={draft.gstin}
                onChange={(event) => {
                  set('gstin')(event.target.value);
                }}
              />
            </Field>
            <Field
              label={t('taxSettings.stores.legalName')}
              hint={t('taxSettings.stores.legalNameHint')}
            >
              <Input
                value={draft.legalName}
                onChange={(event) => {
                  set('legalName')(event.target.value);
                }}
              />
            </Field>
            {text('tradeName', 'taxSettings.stores.tradeName')}
          </>
        )}
        {text('addressLine', 'taxSettings.stores.address')}
        {text('city', 'taxSettings.stores.city')}
        <Field label={t('taxSettings.stores.pincode')}>
          <Input
            inputMode="numeric"
            maxLength={6}
            value={draft.pincode}
            onChange={(event) => {
              set('pincode')(event.target.value);
            }}
          />
        </Field>
      </div>
    </FormDialog>
  );
}

function RegistrationsCard({
  registrations,
  manage,
}: {
  readonly registrations: GstRegistrations;
  readonly manage: boolean;
}) {
  const { t, label } = useI18n();
  const [editing, setEditing] = useState<StoreGstRegistration | null>(null);
  return (
    <Card title={t('taxSettings.stores.title')}>
      <div className="stack">
        <p className="muted">{t('taxSettings.stores.hint')}</p>
        {registrations.stores.length === 0 ? (
          <p className="muted">{t('taxSettings.stores.empty')}</p>
        ) : (
          <ul className="record-list">
            {registrations.stores.map((store) => (
              <li key={store.storeId} className="record-list__row">
                <span className="tax-entry">
                  <span className="record-list__title">
                    {store.code} · {store.name}{' '}
                    <Badge tone={store.registrationType === 'unregistered' ? 'neutral' : 'success'}>
                      {label('gstRegistrationTypes', store.registrationType)}
                    </Badge>
                  </span>
                  <span className="muted">
                    {[
                      store.stateCode === null
                        ? t('taxSettings.stores.noState')
                        : stateLabel(store.stateCode),
                      store.gstin,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {manage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('taxSettings.stores.editLabel', { name: store.name })}
                    onClick={() => {
                      setEditing(store);
                    }}
                  >
                    {t('taxSettings.stores.edit')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {editing !== null && (
        <RegistrationDialog
          store={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
    </Card>
  );
}

/** A name, a rate and its first day: a new category, or (without the name) its next rate. */
function RateDialog({
  category,
  onClose,
}: {
  readonly category: TaxCategoryView | null;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const [from, setFrom] = useState(todayInIndia());
  const submit = async () => {
    const trimmed = name.trim();
    if (category === null && (trimmed.length < 2 || trimmed.length > 80)) {
      return t('taxSettings.categories.nameInvalid');
    }
    const rateBps = parseRate(rate);
    if (rateBps === null) return t('taxSettings.categories.rateInvalid');
    if (!DATE.test(from)) return t('taxSettings.categories.dateInvalid');
    if (category === null) {
      await api.tax.createCategory({ name: trimmed, rateBps, effectiveFrom: from });
    } else {
      await api.tax.addRate(category.id, { rateBps, effectiveFrom: from });
    }
    await queryClient.invalidateQueries({ queryKey: TAX_CATEGORIES_KEY });
    await queryClient.invalidateQueries({ queryKey: TAX_OPTIONS_KEY });
    toast({
      title:
        category === null
          ? t('taxSettings.categories.created')
          : t('taxSettings.categories.rateAdded'),
      tone: 'success',
    });
    return undefined;
  };
  return (
    <FormDialog
      open
      onClose={onClose}
      title={
        category === null
          ? t('taxSettings.categories.addTitle')
          : t('taxSettings.categories.addRateTitle', { name: category.name })
      }
      submitLabel={t('common.save')}
      onSubmit={submit}
    >
      <div className="form-grid">
        {category === null && (
          <Field label={t('taxSettings.categories.name')} required>
            <Input
              value={name}
              maxLength={80}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>
        )}
        <Field label={t('taxSettings.categories.rate')} required>
          <Input
            inputMode="decimal"
            value={rate}
            onChange={(event) => {
              setRate(event.target.value);
            }}
          />
        </Field>
        <Field
          label={t('taxSettings.categories.startsOn')}
          hint={t('taxSettings.categories.startsOnHint')}
          required
        >
          <Input
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
            }}
          />
        </Field>
      </div>
    </FormDialog>
  );
}

function CategoryRow({
  category,
  manage,
  onAddRate,
}: {
  readonly category: TaxCategoryView;
  readonly manage: boolean;
  readonly onAddRate: () => void;
}) {
  const api = useApi();
  const { t, date } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const change = async (changes: { isActive?: boolean; isDefault?: true }) => {
    try {
      await api.tax.updateCategory(category.id, changes);
      await queryClient.invalidateQueries({ queryKey: TAX_CATEGORIES_KEY });
      await queryClient.invalidateQueries({ queryKey: TAX_OPTIONS_KEY });
      toast({ title: t('taxSettings.categories.updated'), tone: 'success' });
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' });
    }
  };
  const percent = (rateBps: number) =>
    t('taxSettings.categories.rateValue', { rate: basisPointsToPercent(rateBps) });
  return (
    <li className="record-list__row">
      <span className="tax-entry">
        <span className="record-list__title">
          {category.name}{' '}
          {category.isDefault && (
            <Badge tone="primary">{t('taxSettings.categories.default')}</Badge>
          )}
          {!category.isActive && <Badge>{t('taxSettings.categories.inactive')}</Badge>}
        </span>
        <span className="muted">
          {category.currentRateBps === null
            ? t('taxSettings.categories.notStarted')
            : t('taxSettings.categories.today', {
                rate: basisPointsToPercent(category.currentRateBps),
              })}
        </span>
        <ul
          className="tax-rates"
          aria-label={t('taxSettings.categories.history', { name: category.name })}
        >
          {category.rates.map((rate) => (
            <li key={rate.id} className="muted">
              {percent(rate.rateBps)} ·{' '}
              {rate.effectiveTo === null
                ? t('taxSettings.categories.from', { date: date(rate.effectiveFrom) })
                : t('taxSettings.categories.fromTo', {
                    from: date(rate.effectiveFrom),
                    to: date(rate.effectiveTo),
                  })}
            </li>
          ))}
        </ul>
      </span>
      {manage && (
        <span
          className="row"
          role="group"
          aria-label={t('taxSettings.categories.actions', { name: category.name })}
        >
          {category.isActive && (
            <Button variant="ghost" size="sm" onClick={onAddRate}>
              {t('taxSettings.categories.addRate')}
            </Button>
          )}
          {category.isActive && !category.isDefault && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void change({ isDefault: true });
              }}
            >
              {t('taxSettings.categories.makeDefault')}
            </Button>
          )}
          {!category.isDefault && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void change({ isActive: !category.isActive });
              }}
            >
              {category.isActive
                ? t('taxSettings.categories.deactivate')
                : t('taxSettings.categories.activate')}
            </Button>
          )}
        </span>
      )}
    </li>
  );
}

function CategoriesCard({
  categories,
  manage,
}: {
  readonly categories: TaxCategoryView[];
  readonly manage: boolean;
}) {
  const { t } = useI18n();
  // undefined: no dialog; null: a new category; a category: its next rate.
  const [dialog, setDialog] = useState<TaxCategoryView | null | undefined>(undefined);
  return (
    <Card title={t('taxSettings.categories.title')}>
      <div className="stack">
        <p className="muted">{t('taxSettings.categories.hint')}</p>
        <ul className="record-list">
          {categories.map((category) => (
            <CategoryRow
              key={category.id}
              category={category}
              manage={manage}
              onAddRate={() => {
                setDialog(category);
              }}
            />
          ))}
        </ul>
        {manage && (
          <div>
            <Button
              variant="secondary"
              onClick={() => {
                setDialog(null);
              }}
            >
              {t('taxSettings.categories.add')}
            </Button>
          </div>
        )}
      </div>
      {dialog !== undefined && (
        <RateDialog
          // A fresh form for each category.
          key={dialog?.id ?? 'new'}
          category={dialog}
          onClose={() => {
            setDialog(undefined);
          }}
        />
      )}
    </Card>
  );
}

/** /settings/tax: GST registrations per store, and tax categories with their rates. */
export function TaxSettingsPage() {
  const api = useApi();
  const { t } = useI18n();
  const manage = usePermissions()('tax:manage');
  const registrations = useQuery({
    queryKey: REGISTRATIONS_KEY,
    queryFn: ({ signal }) => api.tax.registrations(signal),
  });
  const categories = useQuery({
    queryKey: TAX_CATEGORIES_KEY,
    queryFn: ({ signal }) => api.tax.categories(signal),
  });
  return (
    <>
      <PageHeader title={t('taxSettings.title')} description={t('taxSettings.description')} />
      <div className="stack">
        {!manage && <Alert tone="info">{t('taxSettings.readOnly')}</Alert>}
        <QueryState query={registrations} error="taxSettings.error">
          {(data) => (
            <>
              <BusinessCard registrations={data} manage={manage} />
              <RegistrationsCard registrations={data} manage={manage} />
            </>
          )}
        </QueryState>
        <QueryState query={categories} error="taxSettings.error">
          {(data) => <CategoriesCard categories={data} manage={manage} />}
        </QueryState>
      </div>
    </>
  );
}
