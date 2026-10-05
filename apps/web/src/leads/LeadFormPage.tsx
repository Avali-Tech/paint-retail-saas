import { zodResolver } from '@hookform/resolvers/zod';
import { normalizePhone } from '@paint/shared';
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
import { useMemo, useState } from 'react';
import { useForm, useWatch, type Path } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router';
import { z } from 'zod';
import { LEAD_SOURCES, type Lead } from '../api/leads.js';
import type { Party } from '../api/parties.js';
import { useApi } from '../app/services.js';
import { showApiError } from '../auth/forms.js';
import { useI18n, type I18n } from '../i18n/i18n.js';
import { optional, parseRupees, rupeesInput } from '../lib/inputs.js';
import { QueryState } from '../lib/QueryState.js';
import { PartyPicker } from '../parties/PartyPicker.js';
import { StoreSelect } from '../stock/StoreSelect.js';
import { given, refreshCrm } from './crm.js';
import { MemberField } from './members.js';

function formSchema(t: I18n['t'], creating: boolean, newContact: boolean) {
  const needed = (check: (value: string) => boolean) => (value: string) =>
    !(creating && newContact) || check(value);
  return z.object({
    contactName: z.string().refine(
      needed((value) => value.trim().length >= 2),
      t('leads.form.nameInvalid'),
    ),
    contactPhone: z.string().refine(
      needed((value) => normalizePhone(value) !== null),
      t('leads.form.phoneInvalid'),
    ),
    title: z.string().trim().min(3, t('leads.form.titleInvalid')).max(160),
    requirement: z.string().max(2000),
    source: z.enum(LEAD_SOURCES),
    storeId: z.string().refine((value) => !creating || value !== '', t('leads.form.storeRequired')),
    assignee: z.string(),
    value: z
      .string()
      .refine(
        (value) => value.trim() === '' || (parseRupees(value) ?? -1) >= 0,
        t('leads.form.valueInvalid'),
      ),
    expectedOrderDate: z.string(),
  });
}

type Values = z.output<ReturnType<typeof formSchema>>;

const FIELDS = [
  'title',
  'requirement',
  'source',
  'storeId',
  'expectedOrderDate',
] as const satisfies readonly Path<Values>[];

function initialValues(lead: Lead | null): Values {
  return {
    contactName: '',
    contactPhone: '',
    title: lead?.title ?? '',
    requirement: lead?.requirement ?? '',
    source: lead?.source ?? 'walk_in',
    storeId: '',
    assignee: '',
    value: rupeesInput(lead?.estimatedValuePaise ?? null),
    expectedOrderDate: lead?.expectedOrderDate ?? '',
  };
}

/** Who the lead is for: someone on file, or a new contact typed in. */
type Who = Party | 'new' | null;

function LeadForm({ lead }: { readonly lead: Lead | null }) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [who, setWho] = useState<Who>(null);
  const [message, setMessage] = useState<string | null>(null);
  const creating = lead === null;
  const schema = useMemo(() => formSchema(t, creating, who === 'new'), [t, creating, who]);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: initialValues(lead),
  });
  const { errors, isSubmitting } = form.formState;
  const storeId = useWatch({ control: form.control, name: 'storeId' });
  const assignee = useWatch({ control: form.control, name: 'assignee' });

  const save = async (values: Values) => {
    setMessage(null);
    const paise = values.value.trim() === '' ? null : parseRupees(values.value);
    try {
      let saved: Lead;
      if (lead === null) {
        const party = who === 'new' ? null : who;
        saved = await api.leads.create({
          storeId: values.storeId,
          ...(party === null
            ? {
                contact: {
                  displayName: values.contactName.trim(),
                  phone: String(normalizePhone(values.contactPhone)),
                },
              }
            : { partyId: party.id }),
          title: values.title.trim(),
          source: values.source,
          ...(given(values.requirement) === undefined
            ? {}
            : { requirement: values.requirement.trim() }),
          ...(paise === null ? {} : { estimatedValuePaise: paise }),
          ...(values.expectedOrderDate === ''
            ? {}
            : { expectedOrderDate: values.expectedOrderDate }),
          ...(values.assignee === '' ? {} : { assignedMemberId: values.assignee }),
        });
      } else {
        saved = await api.leads.update(lead.id, {
          title: values.title.trim(),
          requirement: optional(values.requirement),
          source: values.source,
          estimatedValuePaise: paise,
          expectedOrderDate: optional(values.expectedOrderDate),
        });
      }
      await refreshCrm(queryClient);
      toast({ title: t(creating ? 'leads.form.created' : 'common.saved'), tone: 'success' });
      void navigate(`/leads/${saved.id}`);
    } catch (error) {
      setMessage(showApiError(error, FIELDS, form.setError));
    }
  };

  if (creating && who === null) {
    return (
      <div className="stack">
        <PartyPicker
          title={t('leads.form.chooseCustomer')}
          onPick={(party) => {
            setWho(party);
          }}
        />
        <div className="row row--end">
          <Button
            variant="secondary"
            onClick={() => {
              setWho('new');
            }}
          >
            {t('leads.form.newContact')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        void form.handleSubmit(save)(event);
      }}
    >
      {message !== null && <Alert tone="danger">{message}</Alert>}
      {who !== null && (
        <Card
          title={who === 'new' ? t('leads.form.newContact') : who.displayName}
          actions={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setWho(null);
              }}
            >
              {t('leads.form.chooseSomeoneElse')}
            </Button>
          }
        >
          {who === 'new' ? (
            <div className="form-grid">
              <Field
                label={t('leads.form.contactName')}
                required
                error={errors.contactName?.message}
              >
                <Input autoComplete="off" {...form.register('contactName')} />
              </Field>
              <Field
                label={t('leads.form.contactPhone')}
                hint={t('leads.form.contactPhoneHint')}
                required
                error={errors.contactPhone?.message}
              >
                <Input type="tel" inputMode="tel" {...form.register('contactPhone')} />
              </Field>
            </div>
          ) : (
            <p className="muted">{who.phone ?? t('leads.form.noPhone')}</p>
          )}
        </Card>
      )}
      <Card>
        <div className="form-grid">
          <Field label={t('leads.form.title')} required error={errors.title?.message}>
            <Input maxLength={160} {...form.register('title')} />
          </Field>
          <Field label={t('leads.source')}>
            <Select {...form.register('source')}>
              {LEAD_SOURCES.map((value) => (
                <option key={value} value={value}>
                  {label('leadSources', value)}
                </option>
              ))}
            </Select>
          </Field>
          {creating && (
            <StoreSelect
              label={t('crm.store')}
              required
              value={storeId}
              emptyLabel={t('crm.chooseStore')}
              error={errors.storeId?.message}
              onChange={(value) => {
                form.setValue('storeId', value, { shouldValidate: form.formState.isSubmitted });
              }}
            />
          )}
          {creating && (
            <MemberField
              value={assignee}
              onChange={(value) => {
                form.setValue('assignee', value);
              }}
            />
          )}
          <Field label={t('leads.form.value')} error={errors.value?.message}>
            <Input inputMode="decimal" {...form.register('value')} />
          </Field>
          <Field label={t('leads.form.expectedOrderDate')}>
            <Input type="date" {...form.register('expectedOrderDate')} />
          </Field>
        </div>
        <div className="form-wide">
          <Field label={t('leads.form.requirement')}>
            <Textarea maxLength={2000} {...form.register('requirement')} />
          </Field>
        </div>
      </Card>
      <div className="row row--end">
        <Button type="submit" loading={isSubmitting}>
          {creating ? t('leads.form.create') : t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/** /leads/new — capture an enquiry for a customer on file or a new contact. */
export function NewLeadPage() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('leads.form.newTitle')} description={t('leads.form.newHint')} />
      <LeadForm lead={null} />
    </>
  );
}

/** /leads/:id/edit */
export function EditLeadPage() {
  const api = useApi();
  const { t } = useI18n();
  const id = String(useParams().id);
  const lead = useQuery({
    queryKey: ['lead', id],
    queryFn: ({ signal }) => api.leads.get(id, signal),
  });
  return (
    <QueryState query={lead} error="leads.detail.error">
      {(data) => (
        <>
          <PageHeader title={t('leads.form.editTitle', { number: data.number })} />
          <LeadForm lead={data} />
        </>
      )}
    </QueryState>
  );
}
