import { CREDIT_APPROVAL_STATUSES, type CreditApprovalView } from '@paint/shared';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  Icon,
  PageHeader,
  Pagination,
  Select,
  Table,
} from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { APPROVAL_TONE, ApprovalDecision, ApprovalSubject } from './approval-parts.js';

export const APPROVALS_PAGE_SIZE = 50;
const FILTERS = ['status'] as const;
/** The default view: what waits for this member's decision. */
const MINE = 'mine';

/**
 * /credit/approvals — the approval queue (MVP 3 spec §5.3): sales past the credit
 * rules and hold releases waiting for this member, oldest first; any status on request.
 */
export function CreditApprovalsPage() {
  const api = useApi();
  const { t, label, money, date } = useI18n();
  const filters = useUrlFilters(FILTERS);
  const chosen = filters.values.status || MINE;
  const status = CREDIT_APPROVAL_STATUSES.find((value) => value === chosen);
  const mine = chosen === MINE;
  const approvals = useQuery({
    queryKey: ['credit-approvals', { chosen, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.credit.approvals(
        { status, mine, limit: APPROVALS_PAGE_SIZE, offset: filters.offset },
        signal,
      ),
    placeholderData: keepPreviousData,
  });
  const levelOf = (approval: CreditApprovalView) =>
    approval.level === null
      ? t('approvals.releaseLevel')
      : label('creditApprovalLevel', approval.level);

  return (
    <>
      <PageHeader title={t('approvals.title')} description={t('approvals.description')} />
      <Card>
        <div className="filters">
          <Field label={t('approvals.status')}>
            <Select
              value={chosen}
              onChange={(event) => {
                filters.set('status', event.target.value);
              }}
            >
              <option value={MINE}>{t('approvals.mine')}</option>
              {CREDIT_APPROVAL_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {label('creditApprovalStatus', value)}
                </option>
              ))}
              <option value="all">{t('approvals.all')}</option>
            </Select>
          </Field>
        </div>
        <QueryState query={approvals} error="approvals.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState icon={<Icon name="check" size={32} />} title={t('approvals.empty')} />
            ) : (
              <>
                <Table label={t('approvals.title')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('approvals.number')}</th>
                      <th scope="col">{t('approvals.party')}</th>
                      <th scope="col">{t('approvals.what')}</th>
                      <th scope="col">{t('approvals.amount')}</th>
                      <th scope="col">{t('approvals.level')}</th>
                      <th scope="col">{t('approvals.requestedBy')}</th>
                      <th scope="col">{t('approvals.status')}</th>
                      <th scope="col">{t('approvals.decide')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((approval) => (
                      <tr key={approval.id}>
                        <th scope="row">
                          <Link to={`/credit/approvals/${approval.id}`}>{approval.number}</Link>
                        </th>
                        <td>
                          <Link to={`/parties/${approval.party.id}`}>{approval.party.name}</Link>
                          {approval.site !== null && (
                            <span className="cell-meta">
                              {t('approvals.site', { name: approval.site.name })}
                            </span>
                          )}
                        </td>
                        <td>
                          <ApprovalSubject approval={approval} />
                        </td>
                        <td>{approval.kind === 'sale' ? money(approval.amountPaise) : '—'}</td>
                        <td>{levelOf(approval)}</td>
                        <td>
                          {approval.requestedBy.name}
                          <span className="cell-meta">{date(approval.createdAt)}</span>
                        </td>
                        <td>
                          <Badge tone={APPROVAL_TONE[approval.status]}>
                            {label('creditApprovalStatus', approval.status)}
                          </Badge>
                        </td>
                        <td>
                          {approval.canDecide && (
                            <span className="row">
                              <ApprovalDecision approval={approval} />
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={APPROVALS_PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('approvals.pages')}
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
