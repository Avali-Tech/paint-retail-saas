import { Alert, Badge, Button, Card, Dialog, PageHeader, useToast } from '@paint/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import type { Member, MemberChange } from '../api/team.js';
import { useApi } from '../app/services.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { useStores } from '../stock/stores.js';
import { AccessFields, accessProblems, type Access, type AccessErrors } from './AccessFields.js';
import { membersKey, rolesKey, storeSummary } from './team-data.js';

const memberKey = (id: string) => [...membersKey, id] as const;

/** Keeps the member's page and the team list in step after a change. */
function useMemberSaved() {
  const queryClient = useQueryClient();
  return async (member: Member) => {
    queryClient.setQueryData(memberKey(member.id), member);
    await queryClient.invalidateQueries({ queryKey: membersKey, exact: true });
    // Member counts per role change with roles and status.
    await queryClient.invalidateQueries({ queryKey: rolesKey });
  };
}

/** Role and stores; a form for those who may change them, else what is set. */
function AccessCard({ member, editable }: { readonly member: Member; readonly editable: boolean }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const saved = useMemberSaved();
  const [access, setAccess] = useState<Access>({
    roleId: member.role.id,
    allStores: member.allStores,
    storeIds: member.storeIds,
  });
  const [errors, setErrors] = useState<AccessErrors>({});
  const save = useMutation({
    mutationFn: (change: MemberChange) => api.team.updateMember(member.id, change),
    onSuccess: async (updated) => {
      await saved(updated);
      toast({ title: t('team.member.saved'), tone: 'success' });
    },
  });

  return (
    <Card title={t('team.member.access')}>
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const problems = accessProblems(access, t);
          setErrors(problems);
          if (Object.keys(problems).length > 0) return;
          save.mutate({
            roleId: access.roleId,
            allStores: access.allStores,
            storeIds: access.allStores ? [] : access.storeIds,
          });
        }}
      >
        {save.isError && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
        <AccessFields
          value={access}
          onChange={setAccess}
          errors={errors}
          currentRoleId={member.role.id}
          disabled={!editable}
        />
        {editable && (
          <div className="row">
            <Button type="submit" loading={save.isPending}>
              {t('team.member.save')}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

/** Deactivate (signs them out) or reactivate, after confirming the first. */
function StatusCard({ member, editable }: { readonly member: Member; readonly editable: boolean }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const saved = useMemberSaved();
  const [confirming, setConfirming] = useState(false);
  const name = member.user.fullName;
  const change = useMutation({
    mutationFn: (isActive: boolean) => api.team.updateMember(member.id, { isActive }),
    onSuccess: async (updated) => {
      setConfirming(false);
      await saved(updated);
      toast({
        title: updated.isActive
          ? t('team.member.reactivated', { name })
          : t('team.member.deactivated', { name }),
        tone: 'success',
      });
    },
    onError: (error) => {
      toast({ title: errorMessage(error), tone: 'danger' });
    },
  });

  return (
    <Card
      title={t('team.member.status')}
      actions={
        <Badge tone={member.isActive ? 'success' : 'neutral'}>
          {member.isActive ? t('team.active') : t('team.inactive')}
        </Badge>
      }
    >
      <div className="stack">
        <p>{member.isActive ? t('team.member.activeText') : t('team.member.inactiveText')}</p>
        {editable && (
          <div className="row">
            {member.isActive ? (
              <Button
                variant="danger"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                {t('team.member.deactivate')}
              </Button>
            ) : (
              <Button
                variant="secondary"
                loading={change.isPending}
                onClick={() => {
                  change.mutate(true);
                }}
              >
                {t('team.member.reactivate')}
              </Button>
            )}
          </div>
        )}
      </div>
      {confirming && (
        <Dialog
          open
          onOpenChange={() => {
            setConfirming(false);
          }}
          title={t('team.member.deactivateTitle', { name })}
          description={t('team.member.deactivateDescription')}
          closeLabel={t('common.close')}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                loading={change.isPending}
                onClick={() => {
                  change.mutate(false);
                }}
              >
                {t('team.member.deactivate')}
              </Button>
            </>
          }
        />
      )}
    </Card>
  );
}

/** Whether they use an authenticator app; owners can reset it for someone else. */
function TwoFactorCard({
  member,
  canReset,
}: {
  readonly member: Member;
  readonly canReset: boolean;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const saved = useMemberSaved();
  const [confirming, setConfirming] = useState(false);
  const name = member.user.fullName;
  const reset = useMutation({
    mutationFn: () => api.team.resetTwoFactor(member.id),
    onSuccess: async () => {
      setConfirming(false);
      await saved({ ...member, twoFactorEnabled: false });
      toast({ title: t('team.member.resetDone', { name }), tone: 'success' });
    },
    onError: (error) => {
      toast({ title: errorMessage(error), tone: 'danger' });
    },
  });

  return (
    <Card
      title={t('team.member.twoFactorTitle')}
      actions={
        <Badge tone={member.twoFactorEnabled ? 'success' : 'neutral'}>
          {member.twoFactorEnabled ? t('team.on') : t('team.off')}
        </Badge>
      }
    >
      <div className="stack">
        <p>
          {member.twoFactorEnabled ? t('team.member.twoFactorOn') : t('team.member.twoFactorOff')}
        </p>
        {canReset && (
          <>
            <p className="muted">{t('team.member.resetHint')}</p>
            <div className="row">
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                {t('team.member.reset')}
              </Button>
            </div>
          </>
        )}
      </div>
      {confirming && (
        <Dialog
          open
          onOpenChange={() => {
            setConfirming(false);
          }}
          title={t('team.member.resetTitle', { name })}
          description={t('team.member.resetDescription')}
          closeLabel={t('common.close')}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                loading={reset.isPending}
                onClick={() => {
                  reset.mutate();
                }}
              >
                {t('team.member.resetConfirm')}
              </Button>
            </>
          }
        />
      )}
    </Card>
  );
}

function MemberDetail({ member }: { readonly member: Member }) {
  const i18n = useI18n();
  const { t } = i18n;
  const can = usePermissions();
  const profile = useCurrentProfile();
  const stores = useStores();
  const self = member.user.id === profile.user.id;
  const manage = can('members:manage') && !self;
  const facts: [string, string][] = [
    [t('team.form.phone'), member.user.phone ?? t('common.none')],
    [t('team.form.email'), member.user.email ?? t('common.none')],
    [t('team.role'), member.role.name],
    [t('team.stores'), storeSummary(member, stores.data ?? [], i18n)],
  ];
  return (
    <>
      <PageHeader
        title={member.user.fullName}
        description={member.role.name}
        actions={<Link to="/team">{t('team.member.back')}</Link>}
      />
      {self && <Alert tone="info">{t('team.member.ownAccess')}</Alert>}
      {!self && !can('members:manage') && <Alert tone="info">{t('team.member.readOnly')}</Alert>}
      <div className="detail-grid">
        <Card title={t('team.member.contact')}>
          <dl className="facts">
            {facts.map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
        {/* Keyed by the saved access, so the form starts again from what was saved. */}
        <AccessCard
          key={`${member.role.id}:${String(member.allStores)}:${member.storeIds.join()}`}
          member={member}
          editable={manage}
        />
        <StatusCard member={member} editable={manage} />
        {/* The API lets only owners reset someone else's two-factor sign-in. */}
        <TwoFactorCard member={member} canReset={profile.role.key === 'owner' && !self} />
      </div>
    </>
  );
}

/** /team/:id — one member: contact, role and stores, status and two-factor sign-in. */
export function MemberPage() {
  const api = useApi();
  // The route always has an :id.
  const id = String(useParams().id);
  const member = useQuery({
    queryKey: memberKey(id),
    queryFn: ({ signal }) => api.team.member(id, signal),
  });
  return (
    <QueryState query={member} error="team.member.error">
      {(data) => <MemberDetail member={data} />}
    </QueryState>
  );
}
