import {
  CURRENT_GST_STATES,
  GST_REGISTRATION_TYPES,
  TAX_DOCUMENT_KINDS,
  defaultSeries,
  isValidGstin,
  isValidPincode,
  stateCodeFromGstin,
  type GstRegistrationType,
  type StoreGstRegistration,
} from '@paint/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Select,
  useToast,
} from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/errors.js';
import type { Store } from '../api/stock.js';
import type { StoreGstInput } from '../api/tax.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { stateLabel } from '../lib/gst-states.js';
import { QueryState } from '../lib/QueryState.js';
import { REGISTRATIONS_KEY, RegistrationDialog } from '../settings/TaxSettingsPage.js';
import '../styles/setup.css';
import { STORES_KEY } from './setup-api.js';

const KINDS = ['store', 'godown'] as const;
const CODE = /^[A-Z0-9-]{2,12}$/;

/** True when the code makes every kind of document number fit (16 characters, GST rule 46). */
export function isStoreCodeUsable(code: string): boolean {
  return CODE.test(code) && TAX_DOCUMENT_KINDS.every((kind) => defaultSeries(code, kind) !== null);
}

const isName = (name: string) => name.length >= 2 && name.length <= 120;

/** Refreshes every list that shows stores: this page, the pickers and Tax & GST. */
function useRefreshStores() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: STORES_KEY });
    await queryClient.invalidateQueries({ queryKey: REGISTRATIONS_KEY });
    await queryClient.invalidateQueries({ queryKey: ['stores'] });
  };
}

interface NewStoreDraft {
  name: string;
  code: string;
  type: Store['type'];
  registrationType: GstRegistrationType;
  stateCode: string;
  gstin: string;
  addressLine: string;
  city: string;
  pincode: string;
}

const EMPTY: NewStoreDraft = {
  name: '',
  code: '',
  type: 'store',
  registrationType: 'unregistered',
  stateCode: '',
  gstin: '',
  addressLine: '',
  city: '',
  pincode: '',
};

/** A new store with its GST registration and address, saved in one go. */
function CreateStoreDialog({ onClose }: { readonly onClose: () => void }) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const refresh = useRefreshStores();
  const registers = usePermissions()('tax:manage');
  const [draft, setDraft] = useState(EMPTY);
  const registered = draft.registrationType !== 'unregistered';
  const code = draft.code.trim().toUpperCase();
  const gstin = draft.gstin.trim().toUpperCase();
  const set = (field: keyof NewStoreDraft) => (value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };
  const problem = () => {
    if (!isName(draft.name.trim())) return t('storeSettings.form.nameInvalid');
    if (!isStoreCodeUsable(code)) return t('storeSettings.form.codeInvalid');
    if (!registers) return null;
    if (draft.stateCode === '') return t('taxSettings.stores.stateRequired');
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
    const pick = (field: 'addressLine' | 'city' | 'pincode') =>
      draft[field].trim() === '' ? {} : { [field]: draft[field].trim() };
    const registration: StoreGstInput = {
      registrationType: draft.registrationType,
      stateCode: draft.stateCode,
      ...(registered ? { gstin } : {}),
      ...pick('addressLine'),
      ...pick('city'),
      ...pick('pincode'),
    };
    await api.setup.createStore({
      name: draft.name.trim(),
      code,
      type: draft.type,
      ...(registers ? { registration } : {}),
    });
    await refresh();
    toast({ title: t('storeSettings.form.created'), tone: 'success' });
    return undefined;
  };
  const text = (field: keyof NewStoreDraft, labelKey: MessageKey) => (
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
      title={t('storeSettings.form.createTitle')}
      submitLabel={t('storeSettings.form.create')}
      onSubmit={submit}
    >
      <div className="form-grid">
        <Field label={t('storeSettings.form.name')} required>
          <Input
            value={draft.name}
            maxLength={120}
            onChange={(event) => {
              set('name')(event.target.value);
            }}
          />
        </Field>
        <Field
          label={t('storeSettings.form.code')}
          hint={t('storeSettings.form.codeHint')}
          required
        >
          <Input
            className="uppercase"
            value={draft.code}
            maxLength={12}
            autoComplete="off"
            onChange={(event) => {
              set('code')(event.target.value);
            }}
          />
        </Field>
        <KindField value={draft.type} onChange={set('type')} />
      </div>
      {registers && (
        <fieldset className="plain-fieldset stack">
          <legend className="setup-legend">{t('storeSettings.form.gstSection')}</legend>
          <p className="muted">{t('storeSettings.form.gstHint')}</p>
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
        </fieldset>
      )}
    </FormDialog>
  );
}

function KindField({
  value,
  onChange,
}: {
  readonly value: Store['type'];
  readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Field label={t('storeSettings.form.kind')}>
      <Select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {t(`storeSettings.kinds.${kind}`)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Renames a store or changes its kind; its code stays, as documents print it. */
function EditStoreDialog({
  store,
  onClose,
}: {
  readonly store: Store;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefreshStores();
  const [name, setName] = useState(store.name);
  const [type, setType] = useState<Store['type']>(store.type);
  const submit = async () => {
    if (!isName(name.trim())) return t('storeSettings.form.nameInvalid');
    await api.setup.updateStore(store.id, { name: name.trim(), type });
    await refresh();
    toast({ title: t('storeSettings.form.saved'), tone: 'success' });
    return undefined;
  };
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('storeSettings.form.editTitle', { name: `${store.code} · ${store.name}` })}
      submitLabel={t('storeSettings.form.save')}
      onSubmit={submit}
    >
      <div className="form-grid">
        <Field label={t('storeSettings.form.name')} required>
          <Input
            value={name}
            maxLength={120}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        <Field label={t('storeSettings.form.code')}>
          <Input readOnly value={store.code} />
        </Field>
        <KindField
          value={type}
          onChange={(value) => {
            setType(value as Store['type']);
          }}
        />
      </div>
    </FormDialog>
  );
}

function CloseStoreDialog({
  store,
  onClose,
}: {
  readonly store: Store;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefreshStores();
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('storeSettings.closeDialog.title', { name: store.name })}
      description={t('storeSettings.closeDialog.description')}
      submitLabel={t('storeSettings.closeDialog.submit')}
      onSubmit={async () => {
        await api.setup.updateStore(store.id, { isActive: false });
        await refresh();
        toast({ title: t('storeSettings.closeDialog.done'), tone: 'success' });
        return undefined;
      }}
    >
      {null}
    </FormDialog>
  );
}

type Dialog =
  | { readonly kind: 'create' }
  | { readonly kind: 'edit' | 'close'; readonly store: Store }
  | { readonly kind: 'gst'; readonly registration: StoreGstRegistration };

function StoreRow({
  store,
  registration,
  onOpen,
}: {
  readonly store: Store;
  readonly registration: StoreGstRegistration | undefined;
  readonly onOpen: (dialog: Dialog) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefreshStores();
  const [pending, setPending] = useState(false);
  const reopen = async () => {
    setPending(true);
    try {
      await api.setup.updateStore(store.id, { isActive: true });
      await refresh();
      toast({ title: t('storeSettings.reopened'), tone: 'success' });
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' });
    } finally {
      setPending(false);
    }
  };
  const details = [
    registration?.stateCode
      ? stateLabel(registration.stateCode)
      : (store.state ?? t('storeSettings.noState')),
    store.gstin,
    store.city,
  ];
  return (
    <li className="record-list__row">
      <span className="tax-entry">
        <span className="record-list__title">
          {store.code} · {store.name}{' '}
          <Badge tone="neutral">{t(`storeSettings.kinds.${store.type}`)}</Badge>{' '}
          {!store.isActive && <Badge tone="warning">{t('storeSettings.closed')}</Badge>}
        </span>
        <span className="muted">{details.filter(Boolean).join(' · ')}</span>
      </span>
      <span
        className="setup-actions"
        role="group"
        aria-label={t('storeSettings.actions', { name: store.name })}
      >
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('storeSettings.editLabel', { name: store.name })}
          onClick={() => {
            onOpen({ kind: 'edit', store });
          }}
        >
          {t('storeSettings.edit')}
        </Button>
        {registration && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('storeSettings.gstLabel', { name: store.name })}
            onClick={() => {
              onOpen({ kind: 'gst', registration });
            }}
          >
            {t('storeSettings.gst')}
          </Button>
        )}
        {store.isActive ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('storeSettings.closeLabel', { name: store.name })}
            onClick={() => {
              onOpen({ kind: 'close', store });
            }}
          >
            {t('storeSettings.close')}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            loading={pending}
            aria-label={t('storeSettings.reopenLabel', { name: store.name })}
            onClick={() => {
              void reopen();
            }}
          >
            {t('storeSettings.reopen')}
          </Button>
        )}
      </span>
    </li>
  );
}

/** /settings/stores — the business's stores and godowns (PO-102). */
export function StoresPage() {
  const api = useApi();
  const { t } = useI18n();
  const can = usePermissions();
  const refresh = useRefreshStores();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const stores = useQuery({
    queryKey: STORES_KEY,
    queryFn: ({ signal }) => api.setup.stores(signal),
  });
  // Registrations are edited by those who manage tax (owners and admins).
  const registrations = useQuery({
    queryKey: REGISTRATIONS_KEY,
    queryFn: ({ signal }) => api.tax.registrations(signal),
    enabled: can('tax:manage'),
  });
  const close = () => {
    setDialog(null);
  };
  return (
    <>
      <PageHeader
        title={t('storeSettings.title')}
        description={t('storeSettings.description')}
        actions={
          <Button
            onClick={() => {
              setDialog({ kind: 'create' });
            }}
          >
            {t('storeSettings.add')}
          </Button>
        }
      />
      <QueryState query={stores} error="storeSettings.error">
        {(list) => (
          <Card title={t('storeSettings.list')}>
            <div className="stack">
              <p className="muted">{t('storeSettings.access')}</p>
              {list.length === 0 ? (
                <EmptyState
                  icon={<Icon name="settings" size={32} />}
                  title={t('storeSettings.empty')}
                />
              ) : (
                <ul className="record-list">
                  {list.map((store) => (
                    <StoreRow
                      key={store.id}
                      store={store}
                      registration={registrations.data?.stores.find(
                        (entry) => entry.storeId === store.id,
                      )}
                      onOpen={setDialog}
                    />
                  ))}
                </ul>
              )}
            </div>
          </Card>
        )}
      </QueryState>
      {dialog?.kind === 'create' && <CreateStoreDialog onClose={close} />}
      {dialog?.kind === 'edit' && <EditStoreDialog store={dialog.store} onClose={close} />}
      {dialog?.kind === 'close' && <CloseStoreDialog store={dialog.store} onClose={close} />}
      {dialog?.kind === 'gst' && (
        <RegistrationDialog store={dialog.registration} onClose={close} onSaved={refresh} />
      )}
    </>
  );
}
