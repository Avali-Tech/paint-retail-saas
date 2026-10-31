import { isValidGstin } from '@paint/shared';
import {
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Pagination,
  Select,
  Table,
  useToast,
} from '@paint/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { useDebouncedValue, useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { useDays } from './shared.js';

export const PAGE_SIZE = 50;
const FILTERS = ['q'] as const;

/** Adds a supplier: a party with the supplier role. */
function NewSupplierDialog({ onClose }: { readonly onClose: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<'person' | 'organization'>('organization');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [gstin, setGstin] = useState('');
  const [city, setCity] = useState('');
  const [problems, setProblems] = useState<{ name?: string; gstin?: string }>({});

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('purchasing.newSupplier.title')}
      submitLabel={t('purchasing.newSupplier.create')}
      onSubmit={async () => {
        const code = gstin.trim().toUpperCase();
        const found = {
          ...(name.trim().length < 2 ? { name: t('purchasing.newSupplier.nameInvalid') } : {}),
          ...(code !== '' && !isValidGstin(code)
            ? { gstin: t('purchasing.newSupplier.gstinInvalid') }
            : {}),
        };
        setProblems(found);
        if (Object.keys(found).length > 0) return false;
        const created = await api.purchasing.createSupplier({
          kind,
          displayName: name.trim(),
          ...(phone.trim() === '' ? {} : { phone: phone.trim() }),
          ...(code === '' ? {} : { gstin: code }),
          ...(city.trim() === '' ? {} : { city: city.trim() }),
        });
        await queryClient.invalidateQueries({ queryKey: ['suppliers'] });
        toast({ title: t('purchasing.newSupplier.created'), tone: 'success' });
        void navigate(`/suppliers/${created.id}`);
        return undefined;
      }}
    >
      <Field label={t('purchasing.newSupplier.kind')}>
        <Select
          value={kind}
          onChange={(event) => {
            setKind(event.target.value === 'person' ? 'person' : 'organization');
          }}
        >
          <option value="organization">{t('purchasing.newSupplier.organization')}</option>
          <option value="person">{t('purchasing.newSupplier.person')}</option>
        </Select>
      </Field>
      <Field label={t('purchasing.newSupplier.name')} required error={problems.name}>
        <Input
          autoComplete="off"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </Field>
      <Field label={t('purchasing.newSupplier.phone')}>
        <Input
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(event) => {
            setPhone(event.target.value);
          }}
        />
      </Field>
      <Field label={t('purchasing.newSupplier.gstin')} error={problems.gstin}>
        <Input
          className="uppercase"
          maxLength={15}
          value={gstin}
          onChange={(event) => {
            setGstin(event.target.value);
          }}
        />
      </Field>
      <Field label={t('purchasing.newSupplier.city')}>
        <Input
          value={city}
          onChange={(event) => {
            setCity(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

/** /suppliers — who the business buys from. */
export function SuppliersPage() {
  const api = useApi();
  const { t, number } = useI18n();
  const can = usePermissions();
  const days = useDays();
  const filters = useUrlFilters(FILTERS);
  const q = useDebouncedValue(filters.values.q.trim(), 300);
  const [adding, setAdding] = useState(false);
  const suppliers = useQuery({
    queryKey: ['suppliers', { q, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.purchasing.suppliers(
        { q: q || undefined, limit: PAGE_SIZE, offset: filters.offset },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title={t('purchasing.supplierList.title')}
        description={t('purchasing.supplierList.description')}
        actions={
          can('purchasing:manage') && can('parties:manage') ? (
            <Button
              onClick={() => {
                setAdding(true);
              }}
            >
              {t('purchasing.supplierList.new')}
            </Button>
          ) : undefined
        }
      />
      <Card>
        <div className="filters">
          <Field label={t('purchasing.supplierList.search')} className="filters__search">
            <Input
              type="search"
              value={filters.values.q}
              onChange={(event) => {
                filters.set('q', event.target.value);
              }}
            />
          </Field>
        </div>
        <QueryState query={suppliers} error="purchasing.supplierList.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="purchasing" size={32} />}
                title={
                  q === ''
                    ? t('purchasing.supplierList.emptyTitle')
                    : t('purchasing.supplierList.noMatches')
                }
                {...(q === ''
                  ? { description: t('purchasing.supplierList.emptyDescription') }
                  : {})}
              />
            ) : (
              <>
                <Table label={t('purchasing.supplierList.list')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('purchasing.supplierList.name')}</th>
                      <th scope="col">{t('purchasing.supplierList.phone')}</th>
                      <th scope="col">{t('purchasing.supplierList.gstin')}</th>
                      <th scope="col">{t('purchasing.supplierList.terms')}</th>
                      <th scope="col">{t('purchasing.supplierList.leadTime')}</th>
                      <th scope="col" className="ui-num">
                        {t('purchasing.supplierList.products')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((supplier) => (
                      <tr key={supplier.id}>
                        <th scope="row">
                          <Link to={`/suppliers/${supplier.id}`}>{supplier.name}</Link>
                        </th>
                        <td>{supplier.phone ?? t('common.none')}</td>
                        <td>{supplier.gstin ?? t('common.none')}</td>
                        <td>{days.terms(supplier.paymentTermsDays)}</td>
                        <td>{days.days(supplier.leadTimeDays)}</td>
                        <td className="ui-num">{number(supplier.productCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('purchasing.supplierList.pages')}
                  range={(from, to, total) => t('common.range', { from, to, total })}
                  previousLabel={t('common.previous')}
                  nextLabel={t('common.next')}
                />
              </>
            )
          }
        </QueryState>
      </Card>
      {adding && (
        <NewSupplierDialog
          onClose={() => {
            setAdding(false);
          }}
        />
      )}
    </>
  );
}
