import { Badge, Button, Field, Select, Table, Textarea, useToast } from '@paint/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { GRANT_TONES, grantLength } from '../support-access/grants.js';
import { supportViewUrl } from '../support-access/support-tab.js';
import type { GrantView } from './platform-api.js';
import { PLATFORM_QUERY, usePlatformApi } from './session.js';

/** Support grants, for one business or all of them. */
export const grantsKey = (...tenantId: string[]) => [PLATFORM_QUERY, 'grants', ...tenantId];

/** How long access may last once approved (the API allows 15 minutes to 8 hours). */
export const GRANT_MINUTES = [15, 30, 60, 120, 240, 480] as const;

/** A grant's status, with when running access ends. */
export function GrantStatusBadge({ grant }: { readonly grant: GrantView }) {
  const { t, dateTime } = useI18n();
  return (
    <>
      <Badge tone={GRANT_TONES[grant.status]}>
        {t(`platform.support.statuses.${grant.status}`)}
      </Badge>
      {grant.status === 'active' && (
        <span className="cell-meta">
          {/* Running access always has an end. */}
          {t('platform.support.until', { time: dateTime(String(grant.expiresAt)) })}
        </span>
      )}
    </>
  );
}

/**
 * Opens the business's app read-only in a new tab. The tab is opened at once
 * (while the click still counts, so pop-up blockers allow it), then pointed at
 * the support session once the API has started one.
 */
export function useOpenSupportView(): (grantId: string) => Promise<void> {
  const api = usePlatformApi();
  const toast = useToast();
  const { t } = useI18n();
  return async (grantId) => {
    const tab = window.open('', '_blank');
    if (tab === null) {
      toast({ title: t('platform.support.popupBlocked'), tone: 'danger' });
      return;
    }
    try {
      const session = await api.startSupportSession(grantId);
      // The business's app has no business reaching back into the console.
      tab.opener = null;
      tab.location.href = supportViewUrl(session);
      toast({ title: t('platform.support.opened'), tone: 'success' });
    } catch (error) {
      tab.close();
      toast({ title: errorMessage(error), tone: 'danger' });
    }
  };
}

/** Open the read-only view and end access, for running access only. */
export function GrantActions({ grant }: { readonly grant: GrantView }) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const openView = useOpenSupportView();
  const end = useMutation({
    mutationFn: () => api.endGrant(grant.id),
    onSuccess: async () => {
      toast({ title: t('platform.support.ended'), tone: 'success' });
      await queryClient.invalidateQueries({ queryKey: grantsKey() });
    },
    onError: (error) => {
      toast({ title: errorMessage(error), tone: 'danger' });
    },
  });
  if (grant.status !== 'active') return null;
  return (
    <div className="row">
      <Button
        size="sm"
        onClick={() => {
          void openView(grant.id);
        }}
      >
        {t('platform.support.open')}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        loading={end.isPending}
        onClick={() => {
          end.mutate();
        }}
      >
        {t('platform.support.end')}
      </Button>
    </div>
  );
}

/** Support grants with who asked, why, for how long, where they stand and what can be done. */
export function GrantTable({
  grants,
  showBusiness,
}: {
  readonly grants: readonly GrantView[];
  readonly showBusiness: boolean;
}) {
  const { t, dateTime } = useI18n();
  return (
    <Table label={t('platform.support.list')}>
      <thead>
        <tr>
          {showBusiness && <th scope="col">{t('platform.support.business')}</th>}
          <th scope="col">{t('platform.support.requestedBy')}</th>
          <th scope="col">{t('platform.support.why')}</th>
          <th scope="col">{t('platform.support.length')}</th>
          <th scope="col">{t('platform.support.status')}</th>
          <th scope="col">{t('platform.support.requestedAt')}</th>
          <th scope="col">
            <span className="ui-visually-hidden">{t('platform.support.actions')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {grants.map((grant) => (
          <tr key={grant.id}>
            {showBusiness && (
              <th scope="row">
                <Link to={`/platform/tenants/${grant.organization.id}`}>
                  {grant.organization.name}
                </Link>
              </th>
            )}
            <td>{grant.requestedBy}</td>
            <td>{grant.reason}</td>
            <td>{grantLength(t, grant.minutes)}</td>
            <td>
              <GrantStatusBadge grant={grant} />
            </td>
            <td>{dateTime(grant.requestedAt)}</td>
            <td>
              <GrantActions grant={grant} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Asks a business for read-only access: why, and for how long once approved. */
export function RequestAccessDialog({
  tenant,
  onClose,
}: {
  readonly tenant: { readonly id: string; readonly name: string };
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(60);
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('platform.support.requestTitle', { name: tenant.name })}
      submitLabel={t('platform.support.send')}
      onSubmit={async () => {
        if (reason.trim().length < 3) return t('platform.support.reasonInvalid');
        await api.requestSupport(tenant.id, { reason: reason.trim(), minutes });
        toast({ title: t('platform.support.requested'), tone: 'success' });
        await queryClient.invalidateQueries({ queryKey: grantsKey() });
        return undefined;
      }}
    >
      <Field label={t('platform.support.reason')} required>
        <Textarea
          maxLength={500}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
      <Field label={t('platform.support.duration')}>
        <Select
          value={String(minutes)}
          onChange={(event) => {
            setMinutes(Number(event.target.value));
          }}
        >
          {GRANT_MINUTES.map((value) => (
            <option key={value} value={value}>
              {grantLength(t, value)}
            </option>
          ))}
        </Select>
      </Field>
    </FormDialog>
  );
}
