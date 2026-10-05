import { zodResolver } from '@hookform/resolvers/zod';
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
import { useForm, useWatch, type Path, type UseFormRegister } from 'react-hook-form';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { CONTRACT_TYPES, type Contract } from '../api/contracts.js';
import { useApi } from '../app/services.js';
import { showApiError } from '../auth/forms.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { PartyPicker } from '../parties/PartyPicker.js';
import { storeLabel } from '../stock/StoreSelect.js';
import { useStores } from '../stock/stores.js';
import {
  contractSchema,
  contractValues,
  toContractChange,
  toNewContract,
  type ContractValues,
} from './contract-form.js';

const FIELDS = [
  'type',
  'title',
  'storeId',
  'startDate',
  'endDate',
  'renewalDate',
  'terms',
  'creditTerms',
  'discountTerms',
  'notes',
  'assignedMemberId',
] as const satisfies readonly Path<ContractValues>[];

/**
 * Who looks after the contract: active team members, for those who can see the
 * team. A new contract defaults to whoever creates it ("Me").
 */
function AssigneeField({
  register,
  value,
  creating,
}: {
  readonly register: UseFormRegister<ContractValues>;
  readonly value: string;
  readonly creating: boolean;
}) {
  const api = useApi();
  const { t } = useI18n();
  const profile = useCurrentProfile();
  const members = useQuery({ queryKey: ['members'], queryFn: () => api.members.list() });
  return (
    <Field label={t('contracts.form.assignee')}>
      <Select {...register('assignedMemberId')} value={value}>
        {creating && <option value="">{t('contracts.form.assigneeDefault')}</option>}
        {(members.data ?? [])
          .filter((member) => member.isActive && !(creating && member.user.id === profile.user.id))
          .map((member) => (
            <option key={member.id} value={member.id}>
              {member.user.fullName}
            </option>
          ))}
      </Select>
    </Field>
  );
}

function ContractForm({
  contract,
  party,
}: {
  readonly contract: Contract | null;
  readonly party: { readonly id: string; readonly name: string };
}) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const can = usePermissions();
  const stores = useStores();
  const schema = useMemo(() => contractSchema(t), [t]);
  const form = useForm<ContractValues>({
    resolver: zodResolver(schema),
    defaultValues: contractValues(contract),
  });
  const [message, setMessage] = useState<string | null>(null);
  const { errors, isSubmitting } = form.formState;
  // Controlled, so the saved assignee and store show once their lists arrive.
  const storeId = useWatch({ control: form.control, name: 'storeId' });
  const assignee = useWatch({ control: form.control, name: 'assignedMemberId' });

  const save = async (values: ContractValues) => {
    setMessage(null);
    try {
      const saved =
        contract === null
          ? await api.contracts.create(toNewContract(values, party.id))
          : await api.contracts.update(contract.id, toContractChange(values));
      await queryClient.invalidateQueries({ queryKey: ['contracts'] });
      await queryClient.invalidateQueries({ queryKey: ['contract', saved.id] });
      await queryClient.invalidateQueries({ queryKey: ['party', party.id] });
      toast({
        title: t(contract === null ? 'contracts.form.created' : 'contracts.form.saved'),
        tone: 'success',
      });
      void navigate(`/contracts/${saved.id}`);
    } catch (error) {
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
      <Card title={party.name}>
        <div className="form-grid">
          <Field label={t('contracts.type')} required>
            <Select {...form.register('type')}>
              {CONTRACT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {label('contractTypes', value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t('contracts.form.title')}
            hint={t('contracts.form.titleHint')}
            required
            error={errors.title?.message}
          >
            <Input autoComplete="off" maxLength={160} {...form.register('title')} />
          </Field>
          {/* The store is chosen once: it decides who can see the contract. */}
          {contract === null && (
            <Field label={t('contracts.form.store')} hint={t('contracts.form.storeHint')}>
              <Select {...form.register('storeId')} value={storeId}>
                <option value="">{t('contracts.form.wholeBusiness')}</option>
                {(stores.data ?? [])
                  .filter((store) => store.isActive)
                  .map((store) => (
                    <option key={store.id} value={store.id}>
                      {storeLabel(store)}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
          <Field label={t('contracts.form.startDate')} required error={errors.startDate?.message}>
            <Input type="date" {...form.register('startDate')} />
          </Field>
          <Field label={t('contracts.form.endDate')} required error={errors.endDate?.message}>
            <Input type="date" {...form.register('endDate')} />
          </Field>
          <Field
            label={t('contracts.form.renewalDate')}
            hint={t('contracts.form.renewalDateHint')}
            error={errors.renewalDate?.message}
          >
            <Input type="date" {...form.register('renewalDate')} />
          </Field>
          <Field label={t('contracts.form.value')} error={errors.value?.message}>
            <Input inputMode="decimal" autoComplete="off" {...form.register('value')} />
          </Field>
          {can('members:read') && (
            <AssigneeField register={form.register} value={assignee} creating={contract === null} />
          )}
        </div>
      </Card>
      <Card title={t('contracts.detail.terms')}>
        <div className="stack">
          <Field label={t('contracts.form.terms')}>
            <Textarea maxLength={8000} {...form.register('terms')} />
          </Field>
          <Field label={t('contracts.form.creditTerms')}>
            <Textarea maxLength={2000} {...form.register('creditTerms')} />
          </Field>
          <Field label={t('contracts.form.discountTerms')}>
            <Textarea maxLength={2000} {...form.register('discountTerms')} />
          </Field>
          <Field label={t('contracts.form.notes')}>
            <Textarea maxLength={4000} {...form.register('notes')} />
          </Field>
        </div>
      </Card>
      <div className="row row--end">
        <Button type="submit" loading={isSubmitting}>
          {contract === null ? t('contracts.form.create') : t('common.save')}
        </Button>
      </div>
    </form>
  );
}

interface Chosen {
  readonly id: string;
  readonly name: string;
}

/** /contracts/new (?partyId= from a customer): choose who it is with, then the terms. */
export function NewContractPage() {
  const api = useApi();
  const { t } = useI18n();
  const given = useSearchParams()[0].get('partyId') ?? '';
  const [choosing, setChoosing] = useState(given === '');
  const [picked, setPicked] = useState<Chosen | null>(null);
  const party = useQuery({
    queryKey: ['parties', given],
    queryFn: ({ signal }) => api.parties.get(given, signal),
    enabled: given !== '',
  });
  const withParty = (chosen: Chosen) => (
    <div className="stack">
      <div className="row row--end">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setPicked(null);
            setChoosing(true);
          }}
        >
          {t('contracts.form.chooseSomeoneElse')}
        </Button>
      </div>
      <ContractForm key={chosen.id} contract={null} party={chosen} />
    </div>
  );
  return (
    <>
      <PageHeader title={t('contracts.form.newTitle')} />
      {choosing ? (
        <PartyPicker
          title={t('contracts.form.chooseParty')}
          onPick={(chosen) => {
            setPicked({ id: chosen.id, name: chosen.displayName });
            setChoosing(false);
          }}
        />
      ) : picked !== null ? (
        withParty(picked)
      ) : (
        <QueryState query={party} error="parties.detail.error">
          {(data) => withParty({ id: data.id, name: data.displayName })}
        </QueryState>
      )}
    </>
  );
}

/** /contracts/:id/edit — drafts and active contracts. */
export function EditContractPage() {
  const api = useApi();
  const { t } = useI18n();
  const id = String(useParams().id);
  const contract = useQuery({
    queryKey: ['contract', id],
    queryFn: ({ signal }) => api.contracts.get(id, signal),
  });
  return (
    <QueryState query={contract} error="contracts.detail.error">
      {(data) => (
        <>
          <PageHeader title={t('contracts.form.editTitle', { number: data.number })} />
          <ContractForm contract={data} party={data.party} />
        </>
      )}
    </QueryState>
  );
}
