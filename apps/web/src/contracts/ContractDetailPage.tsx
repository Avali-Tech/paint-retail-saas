import { Button, Card, Field, Input, PageHeader, buttonStyle, useToast } from '@paint/ui';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Contract } from '../api/contracts.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { DocumentsPanel } from '../documents/DocumentsPanel.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { addDays, isDate } from '../lib/india-time.js';
import { parseRupees, rupeesInput } from '../lib/inputs.js';
import { QueryState } from '../lib/QueryState.js';
import { ReasonDialog } from '../lib/ReasonDialog.js';
import { ContractBadges } from './contract-ui.js';

type Dialog = 'activate' | 'terminate' | 'renew' | null;

/** Everything a contract change can move: lists, the contract, the customer 360 and search. */
function refreshContracts(queryClient: QueryClient, partyId: string): Promise<void> {
  return queryClient
    .invalidateQueries({
      predicate: (query) => ['contracts', 'contract'].includes(String(query.queryKey[0])),
    })
    .then(() => queryClient.invalidateQueries({ queryKey: ['party', partyId] }));
}

/** Renews the contract: the new one's dates and value; everything else is copied. */
function RenewDialog({
  contract,
  onClose,
}: {
  readonly contract: Contract;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, date } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const defaultStart = addDays(contract.endDate, 1);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [value, setValue] = useState(rupeesInput(contract.valuePaise));
  const [errors, setErrors] = useState<{ end?: string; value?: string }>({});

  const submit = async () => {
    const start = startDate === '' ? defaultStart : startDate;
    const paise = value.trim() === '' ? null : parseRupees(value);
    const problems = {
      ...(!isDate(endDate)
        ? { end: t('contracts.form.dateInvalid') }
        : endDate < start
          ? { end: t('contracts.form.endBeforeStart') }
          : {}),
      ...(paise === null && value.trim() !== '' ? { value: t('contracts.form.valueInvalid') } : {}),
    };
    setErrors(problems);
    if (Object.keys(problems).length > 0) return false;
    const renewed = await api.contracts.renew(contract.id, {
      ...(startDate === '' ? {} : { startDate }),
      endDate,
      valuePaise: paise,
    });
    await refreshContracts(queryClient, contract.party.id);
    toast({ title: t('contracts.detail.renewed', { number: renewed.number }), tone: 'success' });
    void navigate(`/contracts/${renewed.id}`);
    return undefined;
  };

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('contracts.detail.renewTitle', { number: contract.number })}
      description={t('contracts.detail.renewDescription')}
      submitLabel={t('contracts.detail.renew')}
      onSubmit={submit}
    >
      <Field
        label={t('contracts.form.startDate')}
        hint={t('contracts.detail.renewStartHint', { date: date(defaultStart) })}
      >
        <Input
          type="date"
          value={startDate}
          onChange={(event) => {
            setStartDate(event.target.value);
          }}
        />
      </Field>
      <Field label={t('contracts.form.endDate')} required error={errors.end}>
        <Input
          type="date"
          value={endDate}
          onChange={(event) => {
            setEndDate(event.target.value);
          }}
        />
      </Field>
      <Field label={t('contracts.form.value')} error={errors.value}>
        <Input
          inputMode="decimal"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

function Facts({ facts }: { readonly facts: readonly [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {facts.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ContractView({ contract }: { readonly contract: Contract }) {
  const api = useApi();
  const { t, plural, label, money, date } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const can = usePermissions();
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => {
    setDialog(null);
  };
  const manage = can('contracts:manage');
  // "Expired" is an active contract past its end: it can still be renewed or terminated.
  const open = ['draft', 'active', 'expired'].includes(contract.status);
  const running = contract.status === 'active' || contract.status === 'expired';
  const daysToEnd =
    contract.daysToEnd > 0
      ? plural('contracts.detail.daysLeft', contract.daysToEnd)
      : contract.daysToEnd === 0
        ? t('contracts.detail.endsToday')
        : plural('contracts.detail.endedDaysAgo', -contract.daysToEnd);

  const details: [string, ReactNode][] = [
    [
      t('contracts.detail.party'),
      <Link key="party" to={`/parties/${contract.party.id}`}>
        {contract.party.name}
      </Link>,
    ],
    [t('contracts.detail.type'), label('contractTypes', contract.type)],
    [
      t('contracts.detail.store'),
      contract.store === null
        ? t('contracts.form.wholeBusiness')
        : `${contract.store.code} · ${contract.store.name}`,
    ],
    ...(contract.project === null
      ? []
      : [
          [
            t('contracts.detail.project'),
            <Link key="project" to={`/projects/${contract.project.id}`}>
              {contract.project.number} · {contract.project.name}
            </Link>,
          ] as [string, ReactNode],
        ]),
    [t('contracts.detail.startDate'), date(contract.startDate)],
    [
      t('contracts.detail.endDate'),
      `${date(contract.endDate)}${contract.status === 'renewed' || contract.status === 'terminated' ? '' : ` · ${daysToEnd}`}`,
    ],
    [t('contracts.detail.renewalDate'), date(contract.renewalDate)],
    [
      t('contracts.detail.value'),
      contract.valuePaise === null ? t('common.none') : money(contract.valuePaise),
    ],
    [t('contracts.detail.assignedTo'), contract.assignedTo.name],
    ...(contract.terminationReason === null
      ? []
      : [
          [t('contracts.detail.terminationReason'), contract.terminationReason] as [
            string,
            ReactNode,
          ],
        ]),
    ...(contract.renewalOf === null
      ? []
      : [
          [
            t('contracts.detail.renewalOf'),
            <Link key="of" to={`/contracts/${contract.renewalOf.id}`}>
              {contract.renewalOf.number}
            </Link>,
          ] as [string, ReactNode],
        ]),
    ...(contract.renewedBy === null
      ? []
      : [
          [
            t('contracts.detail.renewedBy'),
            <Link key="by" to={`/contracts/${contract.renewedBy.id}`}>
              {contract.renewedBy.number}
            </Link>,
          ] as [string, ReactNode],
        ]),
  ];
  const terms = (
    [
      [t('contracts.form.terms'), contract.terms],
      [t('contracts.form.creditTerms'), contract.creditTerms],
      [t('contracts.form.discountTerms'), contract.discountTerms],
      [t('contracts.form.notes'), contract.notes],
    ] as const
  ).filter((entry): entry is readonly [string, string] => entry[1] !== null);

  return (
    <>
      <PageHeader
        title={`${contract.number} · ${contract.title}`}
        description={<ContractBadges contract={contract} />}
        actions={
          manage && open ? (
            <>
              <Link to={`/contracts/${contract.id}/edit`} {...buttonStyle('secondary')}>
                {t('common.edit')}
              </Link>
              {contract.status === 'draft' && (
                <Button
                  onClick={() => {
                    setDialog('activate');
                  }}
                >
                  {t('contracts.detail.activate')}
                </Button>
              )}
              {running && (
                <Button
                  onClick={() => {
                    setDialog('renew');
                  }}
                >
                  {t('contracts.detail.renew')}
                </Button>
              )}
              <Button
                variant="danger"
                onClick={() => {
                  setDialog('terminate');
                }}
              >
                {t('contracts.detail.terminate')}
              </Button>
            </>
          ) : undefined
        }
      />
      <div className="detail-grid">
        <Card title={t('contracts.detail.details')}>
          <Facts facts={details} />
        </Card>
        <Card title={t('contracts.detail.terms')}>
          {terms.length === 0 ? (
            <p className="muted">{t('contracts.detail.noTerms')}</p>
          ) : (
            <Facts
              facts={terms.map(([name, text]) => [
                name,
                <span key={name} className="prewrap">
                  {text}
                </span>,
              ])}
            />
          )}
        </Card>
        <DocumentsPanel recordType="contract" recordId={contract.id} defaultCategory="contract" />
      </div>
      {dialog === 'activate' && (
        <FormDialog
          open
          onClose={close}
          title={t('contracts.detail.activateTitle', { number: contract.number })}
          description={t('contracts.detail.activateDescription')}
          submitLabel={t('contracts.detail.activate')}
          onSubmit={async () => {
            await api.contracts.activate(contract.id);
            await refreshContracts(queryClient, contract.party.id);
            toast({ title: t('contracts.detail.activated'), tone: 'success' });
            return undefined;
          }}
        >
          {null}
        </FormDialog>
      )}
      {dialog === 'terminate' && (
        <ReasonDialog
          title={t('contracts.detail.terminateTitle', { number: contract.number })}
          description={t('contracts.detail.terminateDescription')}
          submitLabel={t('contracts.detail.terminate')}
          onClose={close}
          onSubmit={async (reason) => {
            await api.contracts.terminate(contract.id, reason);
            await refreshContracts(queryClient, contract.party.id);
            toast({ title: t('contracts.detail.terminated'), tone: 'success' });
          }}
        />
      )}
      {dialog === 'renew' && <RenewDialog contract={contract} onClose={close} />}
    </>
  );
}

/** /contracts/:id — a contract with its terms, documents and the actions its status allows. */
export function ContractDetailPage() {
  const api = useApi();
  const id = String(useParams().id);
  const contract = useQuery({
    queryKey: ['contract', id],
    queryFn: ({ signal }) => api.contracts.get(id, signal),
  });
  return (
    <QueryState query={contract} error="contracts.detail.error">
      {(data) => <ContractView key={data.id} contract={data} />}
    </QueryState>
  );
}
