import { zodResolver } from '@hookform/resolvers/zod';
import {
  isValidGstin,
  isValidPan,
  isValidPincode,
  normalizeEmail,
  normalizePhone,
  panFromGstin,
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
import { useMemo, useState } from 'react';
import { useForm, useWatch, type Path } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router';
import { z } from 'zod';
import { conflictOf } from '../api/conflict.js';
import { errorDetail } from '../api/errors.js';
import {
  CONTACT_METHODS,
  CUSTOMER_TYPES,
  PARTY_ROLES,
  type Party,
  type PartyInput,
} from '../api/parties.js';
import { useApi } from '../app/services.js';
import { showApiError } from '../auth/forms.js';
import { useI18n, type I18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { optional, splitList } from '../lib/inputs.js';

const upper = (value: string) => value.trim().toUpperCase();
const blankOr = (check: (value: string) => boolean) => (value: string) =>
  value.trim() === '' || check(value);

function formSchema(t: I18n['t']) {
  return z.object({
    kind: z.enum(['person', 'organization']),
    displayName: z.string().trim().min(2, t('parties.form.nameInvalid')),
    legalName: z.string(),
    contactPerson: z.string(),
    phone: z.string().refine(
      blankOr((value) => normalizePhone(value) !== null),
      t('parties.form.phoneInvalid'),
    ),
    alternatePhone: z.string().refine(
      blankOr((value) => normalizePhone(value) !== null),
      t('parties.form.phoneInvalid'),
    ),
    email: z.string().refine(
      blankOr((value) => normalizeEmail(value) !== null),
      t('parties.form.emailInvalid'),
    ),
    gstin: z.string().refine(
      blankOr((value) => isValidGstin(upper(value))),
      t('parties.form.gstinInvalid'),
    ),
    pan: z.string().refine(
      blankOr((value) => isValidPan(upper(value))),
      t('parties.form.panInvalid'),
    ),
    addressLine: z.string(),
    city: z.string(),
    state: z.string(),
    pincode: z.string().refine(
      blankOr((value) => isValidPincode(value.trim())),
      t('parties.form.pincodeInvalid'),
    ),
    homeStoreId: z.string(),
    notes: z.string(),
    tags: z.string(),
    roles: z.array(z.enum(PARTY_ROLES)).min(1, t('parties.form.rolesRequired')),
    customerType: z.enum(CUSTOMER_TYPES),
    preferredContact: z.enum(CONTACT_METHODS),
    isActive: z.boolean(),
  });
}

type Values = z.output<ReturnType<typeof formSchema>>;

const FIELDS = [
  'kind',
  'displayName',
  'legalName',
  'contactPerson',
  'phone',
  'alternatePhone',
  'email',
  'gstin',
  'pan',
  'addressLine',
  'city',
  'state',
  'pincode',
  'homeStoreId',
  'notes',
  'tags',
  'roles',
] as const satisfies readonly Path<Values>[];

/** The form's starting values: a new customer, or the party being edited. */
export function initialValues(party: Party | null): Values {
  return {
    kind: party?.kind ?? 'person',
    displayName: party?.displayName ?? '',
    legalName: party?.legalName ?? '',
    contactPerson: party?.contactPerson ?? '',
    phone: party?.phone ?? '',
    alternatePhone: party?.alternatePhone ?? '',
    email: party?.email ?? '',
    gstin: party?.gstin ?? '',
    pan: party?.pan ?? '',
    addressLine: party?.addressLine ?? '',
    city: party?.city ?? '',
    state: party?.state ?? '',
    pincode: party?.pincode ?? '',
    homeStoreId: party?.homeStoreId ?? '',
    notes: party?.notes ?? '',
    tags: party?.tags.join(', ') ?? '',
    roles: party?.roles ?? ['customer'],
    customerType: party?.customer?.customerType ?? 'retail',
    preferredContact: party?.customer?.preferredContact ?? 'phone',
    isActive: party?.isActive ?? true,
  };
}

/**
 * What to send. Editing sends every field, with null to clear an emptied one;
 * creating leaves empty fields out.
 */
export function toInput(values: Values, editing: boolean): PartyInput & { isActive?: boolean } {
  const text = (value: string) => {
    const cleaned = optional(value);
    return editing ? cleaned : (cleaned ?? undefined);
  };
  const code = (value: string) => {
    const cleaned = text(value);
    return typeof cleaned === 'string' ? cleaned.toUpperCase() : cleaned;
  };
  return {
    kind: values.kind,
    displayName: values.displayName.trim(),
    legalName: text(values.legalName),
    contactPerson: text(values.contactPerson),
    phone: text(values.phone),
    alternatePhone: text(values.alternatePhone),
    email: text(values.email),
    gstin: code(values.gstin),
    pan: code(values.pan),
    addressLine: text(values.addressLine),
    city: text(values.city),
    state: text(values.state),
    pincode: text(values.pincode),
    homeStoreId: text(values.homeStoreId),
    notes: text(values.notes),
    tags: splitList(values.tags.toLowerCase()),
    roles: values.roles,
    ...(values.roles.includes('customer')
      ? {
          customer: {
            customerType: values.customerType,
            preferredContact: values.preferredContact,
          },
        }
      : {}),
    ...(editing ? { isActive: values.isActive } : {}),
  };
}

interface Duplicate {
  readonly field: 'phone' | 'gstin';
  readonly existingId: string | null;
}

function PartyForm({ party }: { readonly party: Party | null }) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const schema = useMemo(() => formSchema(t), [t]);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: initialValues(party),
  });
  const [message, setMessage] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<Duplicate | null>(null);
  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: ({ signal }) => api.parties.stores(signal),
  });

  const { errors, isSubmitting } = form.formState;
  const gstin = upper(useWatch({ control: form.control, name: 'gstin' }));
  const gstinValid = isValidGstin(gstin);
  const gstinError =
    errors.gstin?.message ??
    (gstin.length >= 15 && !gstinValid ? t('parties.form.gstinInvalid') : undefined);
  const isCustomer = useWatch({ control: form.control, name: 'roles' }).includes('customer');
  // Controlled, so the saved home store shows once the stores (loaded after the form) arrive.
  const homeStoreId = useWatch({ control: form.control, name: 'homeStoreId' });

  const save = async (values: Values) => {
    setMessage(null);
    setDuplicate(null);
    const input = toInput(values, party !== null);
    try {
      const saved =
        party === null
          ? await api.parties.create(input)
          : await api.parties.update(party.id, input);
      await queryClient.invalidateQueries({ queryKey: ['parties'] });
      await queryClient.invalidateQueries({ queryKey: ['party', saved.id] });
      toast({
        title: party === null ? t('parties.form.created') : t('common.saved'),
        tone: 'success',
      });
      void navigate(`/parties/${saved.id}`);
    } catch (error) {
      const conflict = conflictOf(error);
      if (conflict !== null) {
        setDuplicate({
          // The API names the field in its message ("…with this GSTIN…" or "…mobile number…").
          field: /gstin/i.test(conflict.message) ? 'gstin' : 'phone',
          existingId: errorDetail(conflict, 'existingPartyId'),
        });
        return;
      }
      setMessage(showApiError(error, FIELDS, form.setError));
    }
  };

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        void form.handleSubmit(save)(event);
      }}
    >
      {message !== null && <Alert tone="danger">{message}</Alert>}
      {duplicate !== null && (
        <Alert
          tone="warning"
          action={
            duplicate.existingId === null ? undefined : (
              <Link to={`/parties/${duplicate.existingId}`}>{t('parties.form.openExisting')}</Link>
            )
          }
        >
          {t(
            duplicate.field === 'gstin'
              ? 'parties.form.duplicateGstin'
              : 'parties.form.duplicatePhone',
          )}
        </Alert>
      )}
      <Card>
        <div className="form-grid">
          <Field label={t('parties.form.kind')}>
            <Select {...form.register('kind')}>
              <option value="person">{t('parties.form.person')}</option>
              <option value="organization">{t('parties.form.organization')}</option>
            </Select>
          </Field>
          <Field label={t('parties.form.displayName')} required error={errors.displayName?.message}>
            <Input autoComplete="off" {...form.register('displayName')} />
          </Field>
          <Field label={t('parties.form.legalName')}>
            <Input {...form.register('legalName')} />
          </Field>
          <Field label={t('parties.form.contactPerson')}>
            <Input {...form.register('contactPerson')} />
          </Field>
          <Field label={t('parties.form.phone')} error={errors.phone?.message}>
            <Input type="tel" inputMode="tel" {...form.register('phone')} />
          </Field>
          <Field label={t('parties.form.alternatePhone')} error={errors.alternatePhone?.message}>
            <Input type="tel" inputMode="tel" {...form.register('alternatePhone')} />
          </Field>
          <Field label={t('parties.form.email')} error={errors.email?.message}>
            <Input type="email" inputMode="email" {...form.register('email')} />
          </Field>
          <Field
            label={t('parties.form.gstin')}
            hint={
              gstinValid
                ? t('parties.form.gstinValid', { pan: panFromGstin(gstin) })
                : t('parties.form.gstinHint')
            }
            error={gstinError}
          >
            <Input
              className="uppercase"
              maxLength={15}
              spellCheck={false}
              {...form.register('gstin', {
                onChange: (event: { target: { value: string } }) => {
                  const value = upper(event.target.value);
                  if (isValidGstin(value) && form.getValues('pan').trim() === '') {
                    form.setValue('pan', panFromGstin(value));
                  }
                },
              })}
            />
          </Field>
          <Field label={t('parties.form.pan')} error={errors.pan?.message}>
            <Input className="uppercase" maxLength={10} {...form.register('pan')} />
          </Field>
          <Field label={t('parties.form.addressLine')}>
            <Input {...form.register('addressLine')} />
          </Field>
          <Field label={t('parties.form.city')}>
            <Input {...form.register('city')} />
          </Field>
          <Field label={t('parties.form.state')}>
            <Input {...form.register('state')} />
          </Field>
          <Field label={t('parties.form.pincode')} error={errors.pincode?.message}>
            <Input inputMode="numeric" maxLength={6} {...form.register('pincode')} />
          </Field>
          <Field label={t('parties.form.homeStore')}>
            <Select {...form.register('homeStoreId')} value={homeStoreId}>
              <option value="">{t('parties.form.noHomeStore')}</option>
              {(stores.data ?? []).map((store) => (
                <option key={store.id} value={store.id}>
                  {store.code} · {store.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('parties.form.tags')} hint={t('parties.form.tagsHint')}>
            <Input {...form.register('tags')} />
          </Field>
        </div>
      </Card>
      <Card title={t('parties.form.roles')}>
        <fieldset className="checkbox-grid" aria-label={t('parties.form.roles')}>
          {PARTY_ROLES.map((role) => (
            <Checkbox
              key={role}
              label={label('partyRoles', role)}
              value={role}
              {...form.register('roles')}
            />
          ))}
        </fieldset>
        {errors.roles?.message !== undefined && (
          <p className="ui-field__error" role="alert">
            {errors.roles.message}
          </p>
        )}
        {isCustomer && (
          <div className="form-grid">
            <Field label={t('parties.form.customerType')}>
              <Select {...form.register('customerType')}>
                {CUSTOMER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {label('customerTypes', type)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('parties.form.preferredContact')}>
              <Select {...form.register('preferredContact')}>
                {CONTACT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {label('contactMethods', method)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
      </Card>
      <Card>
        <div className="stack">
          <Field label={t('parties.form.notes')}>
            <Textarea {...form.register('notes')} />
          </Field>
          {party !== null && (
            <Checkbox label={t('parties.form.active')} {...form.register('isActive')} />
          )}
        </div>
      </Card>
      <div className="row row--end">
        <Button type="submit" loading={isSubmitting}>
          {party === null ? t('parties.form.create') : t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/** /parties/new */
export function NewPartyPage() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('parties.form.newTitle')} />
      <PartyForm party={null} />
    </>
  );
}

/** /parties/:id/edit */
export function EditPartyPage() {
  const api = useApi();
  const { t } = useI18n();
  // The route always has an :id.
  const id = String(useParams().id);
  const party = useQuery({
    queryKey: ['party', id, 'record'],
    queryFn: ({ signal }) => api.parties.get(id, signal),
  });
  return (
    <QueryState query={party} error="parties.detail.error">
      {(record) => (
        <>
          <PageHeader title={t('parties.form.editTitle', { name: record.displayName })} />
          <PartyForm party={record} />
        </>
      )}
    </QueryState>
  );
}
