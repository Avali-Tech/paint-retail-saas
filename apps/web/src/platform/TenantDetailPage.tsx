import {
  FEATURE_FLAG_KEYS,
  FEATURE_FLAGS,
  PLAN_KEYS,
  PLANS,
  resolveFeatures,
  type FeatureFlag,
  type PlanKey,
} from '@paint/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  buttonStyle,
  useToast,
} from '@paint/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useI18n } from '../i18n/i18n.js';
import { Facts } from '../leads/Facts.js';
import { FormDialog } from '../lib/FormDialog.js';
import { QueryState } from '../lib/QueryState.js';
import type { TenantChange, TenantDetail } from './platform-api.js';
import { PLATFORM_QUERY, usePlatformApi } from './session.js';
import { GrantTable, RequestAccessDialog, grantsKey } from './support-ui.js';
import { SubscriptionBadges, Usage } from './usage.js';

const tenantKey = (id: string) => [PLATFORM_QUERY, 'tenant', id];

/** "1.5 MB": documents' size for people, in powers of 1024. */
export function formatBytes(bytes: number, number: (value: number) => string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${number(Math.round(value * 10) / 10)} ${String(units[unit])}`;
}

/** Saves a change to the business and shows the answer everywhere it is listed. */
function useTenantUpdate(tenant: TenantDetail) {
  const queryClient = useQueryClient();
  return async (save: () => Promise<TenantDetail>) => {
    const saved = await save();
    queryClient.setQueryData(tenantKey(tenant.id), saved);
    await queryClient.invalidateQueries({ queryKey: [PLATFORM_QUERY, 'tenants'] });
    return saved;
  };
}

function UsageCard({ tenant }: { readonly tenant: TenantDetail }) {
  const { t, number, date, dateTime } = useI18n();
  const { usage, plan } = tenant;
  return (
    <Card title={t('platform.tenant.usageTitle')}>
      <Facts
        facts={[
          [t('platform.tenant.stores'), <Usage used={usage.stores} limit={plan.maxStores} />],
          [t('platform.tenant.members'), <Usage used={usage.members} limit={plan.maxMembers} />],
          [t('platform.tenant.products'), number(usage.products)],
          [t('platform.tenant.parties'), number(usage.parties)],
          [
            t('platform.tenant.documents'),
            t('platform.tenant.documentSize', {
              count: number(usage.documents),
              size: formatBytes(usage.documentBytes, number),
            }),
          ],
          [
            t('platform.tenant.lastSignIn'),
            usage.lastSignInAt === null
              ? t('platform.tenants.never')
              : dateTime(usage.lastSignInAt),
          ],
          [t('platform.tenant.joined'), date(tenant.createdAt)],
        ]}
      />
      <h3 className="section-title">{t('platform.tenant.owners')}</h3>
      {tenant.owners.length === 0 ? (
        <p className="muted">{t('platform.tenant.noOwners')}</p>
      ) : (
        <ul className="record-list">
          {tenant.owners.map((owner) => (
            <li key={`${owner.fullName}-${String(owner.phone)}`}>
              <strong>{owner.fullName}</strong>
              <span className="cell-meta">
                {[owner.phone, owner.email].filter((value) => value !== null).join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SubscriptionCard({ tenant }: { readonly tenant: TenantDetail }) {
  const { t, date } = useI18n();
  const api = usePlatformApi();
  const toast = useToast();
  const update = useTenantUpdate(tenant);
  const [extending, setExtending] = useState(false);
  const [days, setDays] = useState('14');
  const { subscription } = tenant;
  const onTrial = subscription.status === 'trialing' || subscription.status === 'expired';
  return (
    <Card
      title={t('platform.tenant.subscriptionTitle')}
      actions={
        onTrial ? (
          <Button
            size="sm"
            onClick={() => {
              setExtending(true);
            }}
          >
            {t('platform.tenant.extendTrial')}
          </Button>
        ) : undefined
      }
    >
      <Facts
        facts={[
          [t('platform.tenants.status'), <SubscriptionBadges subscription={subscription} />],
          [
            t('platform.tenant.trialEnds'),
            subscription.trialEndsAt === null ? null : date(subscription.trialEndsAt),
          ],
          [
            t('platform.tenant.paidUntil'),
            subscription.currentPeriodEnd === null ? null : date(subscription.currentPeriodEnd),
          ],
          [
            t('platform.tenant.billing'),
            subscription.interval === null
              ? null
              : t(`subscription.intervals.${subscription.interval}`),
          ],
          [
            t('platform.tenant.collection'),
            subscription.gateway !== null
              ? t('platform.tenant.online', { gateway: subscription.gateway })
              : onTrial
                ? null
                : t('platform.tenant.manual'),
          ],
        ]}
      />
      {extending && (
        <FormDialog
          open
          onClose={() => {
            setExtending(false);
          }}
          title={t('platform.tenant.extendTitle', { name: tenant.name })}
          description={t('platform.tenant.extendHint')}
          submitLabel={t('platform.tenant.extendTrial')}
          onSubmit={async () => {
            const count = Number(days);
            if (!Number.isInteger(count) || count < 1 || count > 90) {
              return t('platform.tenant.extendInvalid');
            }
            const saved = await update(() => api.extendTrial(tenant.id, count));
            toast({
              title: t('platform.tenant.extended', {
                date: date(String(saved.subscription.trialEndsAt)),
              }),
              tone: 'success',
            });
            return undefined;
          }}
        >
          <Field label={t('platform.tenant.extendDays')} required>
            <Input
              type="number"
              min={1}
              max={90}
              value={days}
              onChange={(event) => {
                setDays(event.target.value);
              }}
            />
          </Field>
        </FormDialog>
      )}
    </Card>
  );
}

function PlanCard({ tenant }: { readonly tenant: TenantDetail }) {
  const { t, number } = useI18n();
  const api = usePlatformApi();
  const toast = useToast();
  const update = useTenantUpdate(tenant);
  const [plan, setPlan] = useState(tenant.plan.key);
  const change = useMutation({
    mutationFn: () => update(() => api.updateTenant(tenant.id, { plan })),
    onSuccess: (saved) => {
      toast({ title: t('platform.tenant.planSaved', { plan: saved.plan.name }), tone: 'success' });
    },
    onError: (error) => {
      toast({ title: errorMessage(error), tone: 'danger' });
    },
  });
  const chosen = PLANS[plan];
  return (
    <Card title={t('platform.tenant.planTitle')}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          change.mutate();
        }}
      >
        <Field
          label={t('platform.tenant.plan')}
          hint={
            chosen.maxStores === null
              ? t('platform.tenant.planUnlimited')
              : t('platform.tenant.planLimits', {
                  stores: number(chosen.maxStores),
                  members: number(chosen.maxMembers),
                })
          }
        >
          <Select
            value={plan}
            onChange={(event) => {
              setPlan(event.target.value as PlanKey);
            }}
          >
            {PLAN_KEYS.map((key) => (
              <option key={key} value={key}>
                {PLANS[key].name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="row">
          <Button type="submit" loading={change.isPending} disabled={plan === tenant.plan.key}>
            {t('platform.tenant.savePlan')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

type FlagChoice = 'default' | 'on' | 'off';

function FeaturesCard({ tenant }: { readonly tenant: TenantDetail }) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toast = useToast();
  const update = useTenantUpdate(tenant);
  const change = useMutation({
    mutationFn: (featureFlags: NonNullable<TenantChange['featureFlags']>) =>
      update(() => api.updateTenant(tenant.id, { featureFlags })),
    onSuccess: () => {
      toast({ title: t('platform.tenant.featureSaved'), tone: 'success' });
    },
    onError: (error) => {
      toast({ title: errorMessage(error), tone: 'danger' });
    },
  });
  const choiceOf = (flag: FeatureFlag): FlagChoice => {
    const override = tenant.featureOverrides[flag];
    return override === undefined ? 'default' : override ? 'on' : 'off';
  };
  const planDefaults = resolveFeatures(tenant.plan.key, {});
  return (
    <Card title={t('platform.tenant.featuresTitle')}>
      <p className="muted">{t('platform.tenant.featuresHint')}</p>
      <ul className="feature-list">
        {FEATURE_FLAG_KEYS.map((flag) => {
          return (
            <li key={flag}>
              <Field label={FEATURE_FLAGS[flag]}>
                <Select
                  value={choiceOf(flag)}
                  disabled={change.isPending}
                  onChange={(event) => {
                    const value = event.target.value;
                    change.mutate({ [flag]: value === 'default' ? null : value === 'on' });
                  }}
                >
                  <option value="default">
                    {t('platform.tenant.featureDefault', {
                      state: t(planDefaults[flag] ? 'platform.tenant.on' : 'platform.tenant.off'),
                    })}
                  </option>
                  <option value="on">{t('platform.tenant.featureOn')}</option>
                  <option value="off">{t('platform.tenant.featureOff')}</option>
                </Select>
              </Field>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function SuspendDialog({
  tenant,
  onClose,
}: {
  readonly tenant: TenantDetail;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toast = useToast();
  const update = useTenantUpdate(tenant);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('platform.tenant.suspendTitle', { name: tenant.name })}
      description={t('platform.tenant.suspendHint')}
      submitLabel={t('platform.tenant.suspend')}
      onSubmit={async () => {
        if (reason.trim().length < 3) return t('platform.tenant.reasonInvalid');
        if (!confirmed) return t('platform.tenant.suspendConfirmNeeded');
        await update(() => api.suspend(tenant.id, reason.trim()));
        toast({
          title: t('platform.tenant.suspendedToast', { name: tenant.name }),
          tone: 'success',
        });
        return undefined;
      }}
    >
      <Field label={t('platform.tenant.suspendReason')} required>
        <Textarea
          maxLength={500}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
      <Checkbox
        label={t('platform.tenant.suspendConfirm', { name: tenant.name })}
        checked={confirmed}
        onChange={(event) => {
          setConfirmed(event.target.checked);
        }}
      />
    </FormDialog>
  );
}

function SuspensionCard({ tenant }: { readonly tenant: TenantDetail }) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toast = useToast();
  const update = useTenantUpdate(tenant);
  const [dialog, setDialog] = useState<'suspend' | 'reactivate' | null>(null);
  const close = () => {
    setDialog(null);
  };
  const active = tenant.status === 'active';
  return (
    <Card title={t('platform.tenant.suspensionTitle')}>
      <div className="stack">
        <p className="muted">
          {active ? t('platform.tenant.suspendHint') : t('platform.tenant.reactivateHint')}
        </p>
        <div className="row">
          <Button
            variant={active ? 'danger' : 'primary'}
            onClick={() => {
              setDialog(active ? 'suspend' : 'reactivate');
            }}
          >
            {active ? t('platform.tenant.suspend') : t('platform.tenant.reactivate')}
          </Button>
        </div>
      </div>
      {dialog === 'suspend' && <SuspendDialog tenant={tenant} onClose={close} />}
      {dialog === 'reactivate' && (
        <FormDialog
          open
          onClose={close}
          title={t('platform.tenant.reactivateTitle', { name: tenant.name })}
          description={t('platform.tenant.reactivateDescription')}
          submitLabel={t('platform.tenant.reactivate')}
          onSubmit={async () => {
            await update(() => api.reactivate(tenant.id));
            toast({
              title: t('platform.tenant.reactivated', { name: tenant.name }),
              tone: 'success',
            });
            return undefined;
          }}
        >
          {null}
        </FormDialog>
      )}
    </Card>
  );
}

function SupportCard({ tenant }: { readonly tenant: TenantDetail }) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const [asking, setAsking] = useState(false);
  const grants = useQuery({
    queryKey: grantsKey(tenant.id),
    queryFn: ({ signal }) => api.grants(tenant.id, signal),
  });
  return (
    <Card
      title={t('platform.support.tenantTitle')}
      actions={
        <Button
          size="sm"
          onClick={() => {
            setAsking(true);
          }}
        >
          {t('platform.support.request')}
        </Button>
      }
    >
      <p className="muted">{t('platform.support.tenantHint')}</p>
      <QueryState query={grants} error="platform.support.error">
        {(list) =>
          list.length === 0 ? (
            <EmptyState title={t('platform.support.tenantEmpty')} />
          ) : (
            <GrantTable grants={list} showBusiness={false} />
          )
        }
      </QueryState>
      {asking && (
        <RequestAccessDialog
          tenant={tenant}
          onClose={() => {
            setAsking(false);
          }}
        />
      )}
    </Card>
  );
}

/** /platform/tenants/:id — a business's usage, plan, features, suspension and support access. */
export function TenantDetailPage() {
  const { t, date } = useI18n();
  const api = usePlatformApi();
  const { id = '' } = useParams();
  const tenant = useQuery({
    queryKey: tenantKey(id),
    queryFn: ({ signal }) => api.tenant(id, signal),
  });
  return (
    <>
      <Link to="/platform/tenants" {...buttonStyle('ghost', 'sm')}>
        {t('platform.tenant.back')}
      </Link>
      <QueryState query={tenant} error="platform.tenant.error">
        {(business) => (
          <>
            <PageHeader
              title={business.name}
              description={
                <Badge tone={business.status === 'active' ? 'success' : 'danger'}>
                  {business.status === 'active'
                    ? t('platform.tenant.active')
                    : t('platform.tenant.suspended')}
                </Badge>
              }
            />
            {business.status === 'suspended' && (
              <Alert tone="warning">
                {t('platform.tenant.suspendedNotice', {
                  date: date(String(business.suspendedAt)),
                  reason: String(business.suspendReason),
                })}
              </Alert>
            )}
            <div className="detail-grid">
              <UsageCard tenant={business} />
              <PlanCard key={business.plan.key} tenant={business} />
              <SubscriptionCard tenant={business} />
              <FeaturesCard tenant={business} />
              <SuspensionCard tenant={business} />
            </div>
            <SupportCard tenant={business} />
          </>
        )}
      </QueryState>
    </>
  );
}
