import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Pagination,
  Table,
  Textarea,
  useToast,
} from '@paint/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/errors.js';
import type { LoyaltySummary } from '../api/loyalty.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { QueryState } from '../lib/QueryState.js';
import { SalespersonField } from './SalespersonField.js';
import {
  ACTION_FIELDS,
  EMPTY_VALUES,
  LOYALTY_ACTIONS,
  prepareAction,
  type ActionField,
  type ActionValues,
  type LoyaltyAction,
} from './actions.js';

export const LEDGER_PAGE_SIZE = 10;
/** The panel's element id, so /parties/:id/loyalty can scroll to it. */
export const LOYALTY_PANEL_ID = 'loyalty';

/** The points history, newest first, a page at a time. */
function Ledger({ partyId }: { readonly partyId: string }) {
  const api = useApi();
  const { t, label, number, money, dateTime } = useI18n();
  const [offset, setOffset] = useState(0);
  const ledger = useQuery({
    queryKey: ['party', partyId, 'loyalty', offset],
    queryFn: ({ signal }) => api.loyalty.get(partyId, { limit: LEDGER_PAGE_SIZE, offset }, signal),
    placeholderData: keepPreviousData,
  });
  return (
    <QueryState query={ledger} error="loyalty.ledgerError">
      {(view) =>
        view.ledger.items.length === 0 ? (
          <p className="muted">{t('loyalty.noEntries')}</p>
        ) : (
          <>
            <Table label={t('loyalty.history')}>
              <thead>
                <tr>
                  <th scope="col">{t('loyalty.when')}</th>
                  <th scope="col">{t('loyalty.what')}</th>
                  <th scope="col">{t('loyalty.points')}</th>
                  <th scope="col">{t('loyalty.by')}</th>
                </tr>
              </thead>
              <tbody>
                {view.ledger.items.map((entry) => (
                  <tr key={entry.id}>
                    <td>{dateTime(entry.createdAt)}</td>
                    <td>
                      {label('loyaltyKinds', entry.kind)}
                      {[
                        entry.reference,
                        entry.manualPurchasePaise === null
                          ? null
                          : money(entry.manualPurchasePaise),
                        entry.note,
                      ]
                        .filter((part) => part !== null)
                        .map((part, index) => (
                          <span key={index} className="cell-meta">
                            {part}
                          </span>
                        ))}
                    </td>
                    <td className="numeric">
                      {entry.points > 0
                        ? t('loyalty.plus', { points: number(entry.points) })
                        : number(entry.points)}
                    </td>
                    <td>{entry.createdBy === null ? t('loyalty.system') : entry.createdBy.name}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination
              offset={offset}
              limit={LEDGER_PAGE_SIZE}
              total={view.ledger.total}
              onChange={setOffset}
              label={t('loyalty.historyPages')}
              range={(from, to, total) => t('common.range', { from, to, total })}
              previousLabel={t('common.previous')}
              nextLabel={t('common.next')}
            />
          </>
        )
      }
    </QueryState>
  );
}

/**
 * A party's loyalty on its 360 page: enrolment, points, tier and next expiry,
 * the actions loyalty:manage allows on an open account, and the points history.
 */
export function LoyaltyPanel({
  partyId,
  loyalty,
}: {
  readonly partyId: string;
  readonly loyalty: LoyaltySummary;
}) {
  const api = useApi();
  const { t, number, date } = useI18n();
  const manage = usePermissions()('loyalty:manage');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [action, setAction] = useState<LoyaltyAction | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [changing, setChanging] = useState(false);
  const { account } = loyalty;

  /** Closes an open account (no more points) or reopens a closed one. */
  const setStatus = async (status: 'active' | 'closed') => {
    setChanging(true);
    try {
      await api.loyalty.setStatus(partyId, status);
      await queryClient.invalidateQueries({ queryKey: ['party', partyId] });
      toast({
        title: t(status === 'active' ? 'loyalty.reopened' : 'loyalty.closedDone'),
        tone: 'success',
      });
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' });
    } finally {
      setChanging(false);
    }
  };

  if (account === null) {
    return (
      <Card id={LOYALTY_PANEL_ID} title={t('loyalty.title')}>
        <div className="stack">
          <p className="muted">{t('loyalty.notEnrolled')}</p>
          {manage && (
            <div className="row">
              <Button
                onClick={() => {
                  setEnrolling(true);
                }}
              >
                {t('loyalty.enrol')}
              </Button>
            </div>
          )}
        </div>
        {enrolling && (
          <EnrolDialog
            partyId={partyId}
            onClose={() => {
              setEnrolling(false);
            }}
          />
        )}
      </Card>
    );
  }

  const facts: [string, string][] = [
    [t('loyalty.balance'), t('loyalty.pointsValue', { points: number(loyalty.balance) })],
    [t('loyalty.tier'), loyalty.tier === null ? t('common.none') : loyalty.tier.name],
    [
      t('loyalty.nextTier'),
      loyalty.nextTier === null
        ? t('common.none')
        : t('loyalty.nextTierValue', {
            name: loyalty.nextTier.name,
            points: number(loyalty.nextTier.pointsToGo),
          }),
    ],
    [t('loyalty.earned'), number(loyalty.totalEarned)],
    [t('loyalty.redeemed'), number(loyalty.totalRedeemed)],
    [
      t('loyalty.nextExpiry'),
      loyalty.nextExpiry === null
        ? t('common.none')
        : t('loyalty.expiryValue', {
            points: number(loyalty.nextExpiry.points),
            date: date(loyalty.nextExpiry.expiresOn),
          }),
    ],
    [
      t('loyalty.salesperson'),
      account.assignedTo === null ? t('common.none') : account.assignedTo.name,
    ],
  ];
  const open = account.status === 'active';

  return (
    <Card
      id={LOYALTY_PANEL_ID}
      title={t('loyalty.title')}
      actions={
        <Badge tone={open ? 'success' : 'neutral'}>
          {t(open ? 'loyalty.active' : 'loyalty.closed')}
        </Badge>
      }
      className="detail-grid__wide"
    >
      <div className="stack">
        <dl className="facts">
          {facts.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {manage && (
          <div className="row">
            {open &&
              LOYALTY_ACTIONS.map((kind) => (
                <Button
                  key={kind}
                  variant="secondary"
                  onClick={() => {
                    setAction(kind);
                  }}
                >
                  {t(`loyalty.actions.${kind}`)}
                </Button>
              ))}
            <Button
              variant="ghost"
              loading={changing}
              onClick={() => {
                void setStatus(open ? 'closed' : 'active');
              }}
            >
              {t(open ? 'loyalty.close' : 'loyalty.reopen')}
            </Button>
          </div>
        )}
        <h3 className="subheading">{t('loyalty.history')}</h3>
        <Ledger partyId={partyId} />
      </div>
      {action !== null && (
        <ActionDialog
          action={action}
          partyId={partyId}
          onClose={() => {
            setAction(null);
          }}
        />
      )}
    </Card>
  );
}

/** Enrols the party, optionally with the salesperson who looks after the account. */
function EnrolDialog({
  partyId,
  onClose,
}: {
  readonly partyId: string;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [salesperson, setSalesperson] = useState('');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('loyalty.enrolTitle')}
      description={t('loyalty.enrolHint')}
      submitLabel={t('loyalty.enrolSubmit')}
      onSubmit={async () => {
        await api.loyalty.enrol(partyId, salesperson === '' ? undefined : salesperson);
        await queryClient.invalidateQueries({ queryKey: ['party', partyId] });
        toast({ title: t('loyalty.enrolled'), tone: 'success' });
        return undefined;
      }}
    >
      <SalespersonField value={salesperson} onChange={setSalesperson} />
    </FormDialog>
  );
}

/** The fields for one loyalty action, checked, then sent. */
function ActionDialog({
  action,
  partyId,
  onClose,
}: {
  readonly action: LoyaltyAction;
  readonly partyId: string;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<ActionValues>(EMPTY_VALUES);
  const set = (field: ActionField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
  };
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t(`loyalty.actions.${action}`)}
      submitLabel={t('common.save')}
      onSubmit={async () => {
        const prepared = prepareAction(action, values);
        if ('problem' in prepared) return t(prepared.problem);
        await prepared.call(api.loyalty, partyId);
        await queryClient.invalidateQueries({ queryKey: ['party', partyId] });
        toast({ title: t('loyalty.saved'), tone: 'success' });
        return undefined;
      }}
    >
      {ACTION_FIELDS[action].map((field) =>
        field === 'note' || field === 'reason' ? (
          <Field key={field} label={t(`loyalty.fields.${field}`)}>
            <Textarea
              value={values[field]}
              onChange={(event) => {
                set(field, event.target.value);
              }}
            />
          </Field>
        ) : (
          <Field
            key={field}
            label={t(`loyalty.fields.${field}`)}
            {...(field === 'points' && action === 'adjust'
              ? { hint: t('loyalty.adjustHint') }
              : {})}
          >
            <Input
              inputMode={field === 'amount' || field === 'points' ? 'decimal' : 'text'}
              value={values[field]}
              onChange={(event) => {
                set(field, event.target.value);
              }}
            />
          </Field>
        ),
      )}
    </FormDialog>
  );
}
