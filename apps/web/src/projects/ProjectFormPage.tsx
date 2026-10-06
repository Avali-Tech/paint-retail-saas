import { zodResolver } from '@hookform/resolvers/zod';
import { isValidPincode } from '@paint/shared';
import { Alert, Button, Card, Field, Input, PageHeader, Textarea, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm, useWatch, type Path } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router';
import { z } from 'zod';
import type { Party } from '../api/parties.js';
import type { Project, ProjectDetails } from '../api/projects.js';
import { useApi } from '../app/services.js';
import { showApiError } from '../auth/forms.js';
import { useI18n, type I18n } from '../i18n/i18n.js';
import { refreshCrm } from '../leads/crm.js';
import { MemberField } from '../leads/members.js';
import { optional, parseNumber, parseRupees, rupeesInput } from '../lib/inputs.js';
import { QueryState } from '../lib/QueryState.js';
import { PartyPicker } from '../parties/PartyPicker.js';
import { StoreSelect } from '../stock/StoreSelect.js';

const blankOr = (check: (value: string) => boolean) => (value: string) =>
  value.trim() === '' || check(value);
const positive = (places: number) => (value: string) => {
  const number = parseNumber(value);
  return number !== null && number > 0 && Number(number.toFixed(places)) === number;
};

function formSchema(t: I18n['t'], creating: boolean) {
  return z
    .object({
      name: z.string().trim().min(1, t('projects.form.nameInvalid')).max(160),
      storeId: z
        .string()
        .refine((value) => !creating || value !== '', t('leads.form.storeRequired')),
      assignee: z.string(),
      addressLine: z.string().max(300),
      city: z.string().max(80),
      state: z.string().max(80),
      pincode: z.string().refine(
        blankOr((value) => isValidPincode(value.trim())),
        t('projects.form.pincodeInvalid'),
      ),
      startDate: z.string(),
      expectedCompletionDate: z.string(),
      area: z.string().refine(blankOr(positive(2)), t('projects.form.areaInvalid')),
      litres: z.string().refine(blankOr(positive(3)), t('projects.form.litresInvalid')),
      value: z.string().refine(
        blankOr((value) => (parseRupees(value) ?? -1) >= 0),
        t('leads.form.valueInvalid'),
      ),
      notes: z.string().max(4000),
    })
    .refine(
      (values) =>
        values.startDate === '' ||
        values.expectedCompletionDate === '' ||
        values.expectedCompletionDate >= values.startDate,
      { path: ['expectedCompletionDate'], message: t('projects.form.datesInvalid') },
    );
}

type Values = z.output<ReturnType<typeof formSchema>>;

const FIELDS = [
  'name',
  'storeId',
  'addressLine',
  'city',
  'state',
  'pincode',
  'startDate',
  'expectedCompletionDate',
  'notes',
] as const satisfies readonly Path<Values>[];

function initialValues(project: Project | null): Values {
  const site = project?.site;
  const amount = (value: number | null | undefined) =>
    value === null || value === undefined ? '' : String(value);
  return {
    name: project?.name ?? '',
    storeId: '',
    assignee: '',
    addressLine: site?.addressLine ?? '',
    city: site?.city ?? '',
    state: site?.state ?? '',
    pincode: site?.pincode ?? '',
    startDate: project?.startDate ?? '',
    expectedCompletionDate: project?.expectedCompletionDate ?? '',
    area: amount(project?.estimatedAreaSqFt),
    litres: amount(project?.estimatedPaintLitres),
    value: rupeesInput(project?.expectedOrderValuePaise ?? null),
    notes: project?.notes ?? '',
  };
}

/** The site and job details to send; null clears an emptied field. */
export function toDetails(values: Values): ProjectDetails & { readonly name: string } {
  const amount = (text: string) => (text.trim() === '' ? null : parseNumber(text));
  return {
    name: values.name.trim(),
    addressLine: optional(values.addressLine),
    city: optional(values.city),
    state: optional(values.state),
    pincode: optional(values.pincode),
    startDate: optional(values.startDate),
    expectedCompletionDate: optional(values.expectedCompletionDate),
    estimatedAreaSqFt: amount(values.area),
    estimatedPaintLitres: amount(values.litres),
    expectedOrderValuePaise: values.value.trim() === '' ? null : parseRupees(values.value),
    notes: optional(values.notes),
  };
}

/** A new project leaves out what was not filled in. */
function withoutEmpty(details: ProjectDetails): ProjectDetails {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== null));
}

function ProjectForm({ project }: { readonly project: Project | null }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [customer, setCustomer] = useState<Party | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const creating = project === null;
  const schema = useMemo(() => formSchema(t, creating), [t, creating]);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: initialValues(project),
  });
  const { errors, isSubmitting } = form.formState;
  const storeId = useWatch({ control: form.control, name: 'storeId' });
  const assignee = useWatch({ control: form.control, name: 'assignee' });

  const save = async (values: Values) => {
    setMessage(null);
    const details = toDetails(values);
    try {
      const saved =
        project === null
          ? await api.projects.create({
              ...withoutEmpty(details),
              name: details.name,
              storeId: values.storeId,
              customerPartyId: String(customer?.id),
              ...(values.assignee === '' ? {} : { assignedMemberId: values.assignee }),
            })
          : await api.projects.update(project.id, details);
      await refreshCrm(queryClient);
      toast({ title: t(creating ? 'projects.form.created' : 'common.saved'), tone: 'success' });
      void navigate(`/projects/${saved.id}`);
    } catch (error) {
      setMessage(showApiError(error, FIELDS, form.setError));
    }
  };

  if (creating && customer === null) {
    return <PartyPicker title={t('projects.form.chooseCustomer')} onPick={setCustomer} />;
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
      {customer !== null && (
        <Card
          title={t('projects.form.customerValue', { name: customer.displayName })}
          actions={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCustomer(null);
              }}
            >
              {t('leads.form.chooseSomeoneElse')}
            </Button>
          }
        >
          <p className="muted">{customer.phone ?? t('leads.form.noPhone')}</p>
        </Card>
      )}
      <Card>
        <div className="form-grid">
          <Field label={t('projects.form.name')} required error={errors.name?.message}>
            <Input maxLength={160} {...form.register('name')} />
          </Field>
          {creating && (
            <>
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
              <MemberField
                value={assignee}
                onChange={(value) => {
                  form.setValue('assignee', value);
                }}
              />
            </>
          )}
          <Field label={t('projects.form.startDate')}>
            <Input type="date" {...form.register('startDate')} />
          </Field>
          <Field
            label={t('projects.form.expectedCompletionDate')}
            error={errors.expectedCompletionDate?.message}
          >
            <Input type="date" {...form.register('expectedCompletionDate')} />
          </Field>
        </div>
      </Card>
      <Card title={t('projects.detail.site')}>
        <div className="form-grid">
          <Field label={t('projects.form.addressLine')}>
            <Input maxLength={300} {...form.register('addressLine')} />
          </Field>
          <Field label={t('projects.form.city')}>
            <Input maxLength={80} {...form.register('city')} />
          </Field>
          <Field label={t('projects.form.state')}>
            <Input maxLength={80} {...form.register('state')} />
          </Field>
          <Field label={t('projects.form.pincode')} error={errors.pincode?.message}>
            <Input inputMode="numeric" maxLength={6} {...form.register('pincode')} />
          </Field>
        </div>
      </Card>
      <Card title={t('projects.detail.job')}>
        <div className="form-grid">
          <Field label={t('projects.form.area')} error={errors.area?.message}>
            <Input inputMode="decimal" {...form.register('area')} />
          </Field>
          <Field label={t('projects.form.litres')} error={errors.litres?.message}>
            <Input inputMode="decimal" {...form.register('litres')} />
          </Field>
          <Field label={t('projects.form.value')} error={errors.value?.message}>
            <Input inputMode="decimal" {...form.register('value')} />
          </Field>
        </div>
        <div className="form-wide">
          <Field label={t('projects.form.notes')}>
            <Textarea maxLength={4000} {...form.register('notes')} />
          </Field>
        </div>
      </Card>
      <div className="row row--end">
        <Button type="submit" loading={isSubmitting}>
          {creating ? t('projects.form.create') : t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/** /projects/new — choose the customer (the site's owner), then the site and job. */
export function NewProjectPage() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('projects.form.newTitle')} description={t('projects.form.newHint')} />
      <ProjectForm project={null} />
    </>
  );
}

/** /projects/:id/edit */
export function EditProjectPage() {
  const api = useApi();
  const { t } = useI18n();
  const id = String(useParams().id);
  const project = useQuery({
    queryKey: ['project', id],
    queryFn: ({ signal }) => api.projects.get(id, signal),
  });
  return (
    <QueryState query={project} error="projects.detail.error">
      {(data) => (
        <>
          <PageHeader title={t('projects.form.editTitle', { number: data.number })} />
          <ProjectForm project={data} />
        </>
      )}
    </QueryState>
  );
}
