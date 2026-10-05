import {
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Pagination,
  Select,
  Table,
  buttonStyle,
} from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { CONTRACT_STATUSES, CONTRACT_TYPES } from '../api/contracts.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useDebouncedValue, useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { PartyPicker } from '../parties/PartyPicker.js';
import { ContractBadges } from './contract-ui.js';

export const CONTRACT_PAGE_SIZE = 50;
export const SEARCH_DELAY_MS = 300;
const FILTERS = ['q', 'type', 'status', 'partyId', 'renewalDue'] as const;

/** "30" -> 30 when it is a whole number of days the API accepts (0 to 366). */
export function renewalDays(text: string): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const days = Number(text.trim());
  return days <= 366 ? days : null;
}

/** The party filter: who is chosen (by name), or a button to choose someone. */
function PartyFilter({
  partyId,
  onChange,
}: {
  readonly partyId: string;
  readonly onChange: (partyId: string) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const [choosing, setChoosing] = useState(false);
  const party = useQuery({
    queryKey: ['parties', partyId],
    queryFn: ({ signal }) => api.parties.get(partyId, signal),
    enabled: partyId !== '',
  });
  return (
    <div className="ui-field">
      <span className="ui-field__label">{t('contracts.party')}</span>
      <span className="row">
        <span>
          {partyId === ''
            ? t('contracts.anyParty')
            : (party.data?.displayName ?? t('common.loading'))}
        </span>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setChoosing(true);
          }}
        >
          {t('contracts.chooseParty')}
        </Button>
        {partyId !== '' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onChange('');
            }}
          >
            {t('contracts.clearParty')}
          </Button>
        )}
      </span>
      <Dialog
        open={choosing}
        onOpenChange={setChoosing}
        title={t('contracts.chooseParty')}
        closeLabel={t('common.close')}
      >
        <PartyPicker
          title={t('contracts.party')}
          onPick={(chosen) => {
            setChoosing(false);
            onChange(chosen.id);
          }}
        />
      </Dialog>
    </div>
  );
}

/** /contracts — agreements with filters for type, status, party and renewals coming up. */
export function ContractsPage() {
  const api = useApi();
  const { t, label, money, date } = useI18n();
  const can = usePermissions();
  const filters = useUrlFilters(FILTERS);
  const q = useDebouncedValue(filters.values.q.trim(), SEARCH_DELAY_MS);
  const type = CONTRACT_TYPES.find((value) => value === filters.values.type);
  const status = CONTRACT_STATUSES.find((value) => value === filters.values.status);
  const { partyId } = filters.values;
  // What is typed stays in the address; only a valid number of days filters.
  const renewalDue = renewalDays(filters.values.renewalDue);
  const daysError =
    filters.values.renewalDue.trim() !== '' && renewalDue === null
      ? t('contracts.renewalDueInvalid')
      : undefined;
  const filtered = Object.values(filters.values).some((value) => value !== '');

  const contracts = useQuery({
    queryKey: ['contracts', { q, type, status, partyId, renewalDue, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.contracts.list(
        {
          ...(q === '' ? {} : { q }),
          ...(type === undefined ? {} : { type }),
          ...(status === undefined ? {} : { status }),
          ...(partyId === '' ? {} : { partyId }),
          ...(renewalDue === null ? {} : { renewalDue }),
          limit: CONTRACT_PAGE_SIZE,
          offset: filters.offset,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title={t('contracts.title')}
        description={t('contracts.description')}
        actions={
          can('contracts:manage') ? (
            <Link
              to={partyId === '' ? '/contracts/new' : `/contracts/new?partyId=${partyId}`}
              {...buttonStyle('primary')}
            >
              {t('contracts.new')}
            </Link>
          ) : undefined
        }
      />
      <Card>
        <div className="filters">
          <Field label={t('contracts.search')} className="filters__search">
            <Input
              type="search"
              value={filters.values.q}
              onChange={(event) => {
                filters.set('q', event.target.value);
              }}
            />
          </Field>
          <Field label={t('contracts.type')}>
            <Select
              value={type ?? ''}
              onChange={(event) => {
                filters.set('type', event.target.value);
              }}
            >
              <option value="">{t('contracts.allTypes')}</option>
              {CONTRACT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {label('contractTypes', value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('contracts.status')}>
            <Select
              value={status ?? ''}
              onChange={(event) => {
                filters.set('status', event.target.value);
              }}
            >
              <option value="">{t('contracts.allStatuses')}</option>
              {CONTRACT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {label('contractStatus', value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t('contracts.renewalDue')}
            hint={t('contracts.renewalDueHint')}
            error={daysError}
          >
            <Input
              inputMode="numeric"
              value={filters.values.renewalDue}
              onChange={(event) => {
                filters.set('renewalDue', event.target.value);
              }}
            />
          </Field>
          <PartyFilter
            partyId={partyId}
            onChange={(partyId) => {
              filters.set('partyId', partyId);
            }}
          />
        </div>
        <QueryState query={contracts} error="contracts.error">
          {(page) =>
            page.items.length === 0 ? (
              filtered ? (
                <EmptyState
                  icon={<Icon name="contracts" size={32} />}
                  title={t('contracts.noMatches')}
                />
              ) : (
                <EmptyState
                  icon={<Icon name="contracts" size={32} />}
                  title={t('contracts.empty')}
                  description={t('contracts.emptyDescription')}
                />
              )
            ) : (
              <>
                <Table label={t('contracts.title')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('contracts.number')}</th>
                      <th scope="col">{t('contracts.party')}</th>
                      <th scope="col">{t('contracts.type')}</th>
                      <th scope="col">{t('contracts.status')}</th>
                      <th scope="col">{t('contracts.dates')}</th>
                      <th scope="col" className="ui-num">
                        {t('contracts.value')}
                      </th>
                      <th scope="col">{t('contracts.assignedTo')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((contract) => (
                      <tr key={contract.id}>
                        <th scope="row">
                          <Link to={`/contracts/${contract.id}`}>{contract.number}</Link>
                          <span className="cell-meta">{contract.title}</span>
                        </th>
                        <td>
                          <Link to={`/parties/${contract.party.id}`}>{contract.party.name}</Link>
                        </td>
                        <td>{label('contractTypes', contract.type)}</td>
                        <td>
                          <ContractBadges contract={contract} />
                        </td>
                        <td>
                          {t('contracts.dateRange', {
                            start: date(contract.startDate),
                            end: date(contract.endDate),
                          })}
                        </td>
                        <td className="ui-num">
                          {contract.valuePaise === null
                            ? t('common.none')
                            : money(contract.valuePaise)}
                        </td>
                        <td>{contract.assignedTo.name}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={CONTRACT_PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('contracts.pages')}
                  range={(from, to, total) => t('common.range', { from, to, total })}
                  previousLabel={t('common.previous')}
                  nextLabel={t('common.next')}
                />
              </>
            )
          }
        </QueryState>
      </Card>
    </>
  );
}
