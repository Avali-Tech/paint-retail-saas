import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Spinner,
  buttonStyle,
  useToast,
} from '@paint/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { z } from 'zod';
import { errorMessage } from '../api/errors.js';
import type { TwoFactorEnrolment } from '../api/types.js';
import { useApi } from '../app/services.js';
import { AuthenticatorSetup } from '../auth/AuthenticatorSetup.js';
import { showApiError } from '../auth/forms.js';
import { RecoveryCodes } from '../auth/RecoveryCodes.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';

export const twoFactorStatusKey = ['two-factor-status'] as const;
export const organizationSecurityKey = ['organization-security'] as const;

/** A failed load, with a way to try again. */
function LoadError({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <Alert
      tone="danger"
      action={
        <Button variant="secondary" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      }
    >
      {errorMessage(error)}
    </Alert>
  );
}

interface CodeValues {
  code: string;
}

/** A small form that sends one code (from the app, or a recovery code) to do something. */
function CodeAction({
  title,
  hint,
  label,
  submitLabel,
  variant = 'secondary',
  onSubmit,
}: {
  readonly title: string;
  readonly hint?: ReactNode;
  readonly label: string;
  readonly submitLabel: string;
  readonly variant?: 'primary' | 'secondary' | 'danger';
  readonly onSubmit: (code: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const schema = useMemo(
    () => z.object({ code: z.string().trim().min(6, t('security.invalidCode')).max(20) }),
    [t],
  );
  const form = useForm<CodeValues>({ resolver: zodResolver(schema), defaultValues: { code: '' } });
  const [message, setMessage] = useState<string | null>(null);
  const { errors, isSubmitting } = form.formState;
  return (
    <form
      className="stack code-action"
      noValidate
      aria-labelledby={titleId}
      onSubmit={(event) => {
        void form.handleSubmit(async ({ code }) => {
          setMessage(null);
          try {
            await onSubmit(code);
          } catch (error) {
            setMessage(showApiError(error, ['code'], form.setError));
          }
          form.reset({ code: '' }, { keepErrors: true });
        })(event);
      }}
    >
      <h3 id={titleId} className="code-action__title">
        {title}
      </h3>
      {hint !== undefined && <p className="muted">{hint}</p>}
      {message !== null && <Alert tone="danger">{message}</Alert>}
      <Field label={label} error={errors.code?.message}>
        <Input autoComplete="one-time-code" spellCheck={false} {...form.register('code')} />
      </Field>
      <div className="row">
        <Button type="submit" variant={variant} loading={isSubmitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** The member's own two-factor sign-in: add an app, renew recovery codes, or turn it off. */
function AccountTwoFactor() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: twoFactorStatusKey, queryFn: () => api.twoFactor.status() });
  const [enrolment, setEnrolment] = useState<TwoFactorEnrolment | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const enrol = useMutation({
    mutationFn: () => api.twoFactor.enrol(),
    onSuccess: setEnrolment,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: twoFactorStatusKey });

  let body: ReactNode;
  if (status.isPending) {
    body = <Spinner label={t('common.loading')} />;
  } else if (status.isError) {
    body = (
      <LoadError
        error={status.error}
        onRetry={() => {
          void status.refetch();
        }}
      />
    );
  } else if (codes !== null) {
    body = (
      <RecoveryCodes
        codes={codes}
        onDone={() => {
          setCodes(null);
          setEnrolment(null);
          void refresh();
        }}
      />
    );
  } else if (status.data.enabled) {
    body = (
      <>
        <p>{t('security.onText')}</p>
        {status.data.required && <p className="muted">{t('security.required')}</p>}
        <p className="muted">{t('security.codesLeft', { count: status.data.recoveryCodesLeft })}</p>
        <CodeAction
          title={t('security.renew')}
          hint={t('security.renewHint')}
          label={t('security.code')}
          submitLabel={t('security.renewButton')}
          onSubmit={async (code) => {
            setCodes((await api.twoFactor.renewRecoveryCodes(code)).recoveryCodes);
          }}
        />
        <CodeAction
          title={t('security.disable')}
          label={t('security.code')}
          submitLabel={t('security.disableButton')}
          variant="danger"
          onSubmit={async (code) => {
            await api.twoFactor.disable(code);
            toast({ title: t('security.disabled'), tone: 'info' });
            await refresh();
          }}
        />
      </>
    );
  } else {
    body = (
      <>
        <p>{t('security.offText')}</p>
        {status.data.required && <p className="muted">{t('security.required')}</p>}
        {enrol.isError && <Alert tone="danger">{errorMessage(enrol.error)}</Alert>}
        {enrolment === null ? (
          <div className="row">
            <Button
              loading={enrol.isPending}
              onClick={() => {
                enrol.mutate();
              }}
            >
              {t('security.add')}
            </Button>
          </div>
        ) : (
          <>
            <AuthenticatorSetup enrolment={enrolment} />
            <CodeAction
              title={t('twoFactor.setupTitle')}
              label={t('auth.code')}
              submitLabel={t('security.confirm')}
              variant="primary"
              onSubmit={async (code) => {
                setCodes((await api.twoFactor.confirm(code)).recoveryCodes);
                toast({ title: t('security.enabled'), tone: 'success' });
              }}
            />
          </>
        )}
      </>
    );
  }

  return (
    <Card
      title={t('security.account')}
      actions={
        status.data && (
          <Badge tone={status.data.enabled ? 'success' : 'warning'}>
            {status.data.enabled ? t('security.on') : t('security.off')}
          </Badge>
        )
      }
    >
      <div className="stack">{body}</div>
    </Card>
  );
}

/** Owners and admins: whether owners and admins must use two-factor sign-in. */
function BusinessSecurity() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const hintId = useId();
  const [choice, setChoice] = useState<boolean | null>(null);
  const security = useQuery({
    queryKey: organizationSecurityKey,
    queryFn: () => api.organization.security(),
  });
  const save = useMutation({
    mutationFn: (twoFactorRequired: boolean) => api.organization.setSecurity({ twoFactorRequired }),
    onSuccess: (saved) => {
      queryClient.setQueryData(organizationSecurityKey, saved);
      // Whether the member's own sign-in may be turned off depends on it.
      void queryClient.invalidateQueries({ queryKey: twoFactorStatusKey });
      toast({ title: t('security.requireSaved'), tone: 'success' });
    },
    onError: (error) => {
      toast({ title: errorMessage(error), tone: 'danger' });
    },
  });

  return (
    <Card title={t('security.business')}>
      {security.isPending && <Spinner label={t('common.loading')} />}
      {security.isError && (
        <LoadError
          error={security.error}
          onRetry={() => {
            void security.refetch();
          }}
        />
      )}
      {security.data && (
        <div className="stack">
          <label className="check">
            <input
              type="checkbox"
              // While saving, the choice just made; then what the server holds.
              checked={choice ?? security.data.twoFactorRequired}
              disabled={save.isPending}
              aria-describedby={hintId}
              onChange={(event) => {
                setChoice(event.target.checked);
                save.mutate(event.target.checked, {
                  onSettled: () => {
                    setChoice(null);
                  },
                });
              }}
            />
            <span>{t('security.requireLabel')}</span>
          </label>
          <p id={hintId} className="muted">
            {t('security.requireHint')}
          </p>
        </div>
      )}
    </Card>
  );
}

/** Owners: where to reset a member's two-factor sign-in (each member's page under Team). */
function TeamTwoFactor() {
  const { t } = useI18n();
  return (
    <Card title={t('security.team')}>
      <div className="stack">
        <p className="muted">{t('security.teamHint')}</p>
        <div className="row">
          <Link to="/team" {...buttonStyle('secondary')}>
            {t('security.teamLink')}
          </Link>
        </div>
      </div>
    </Card>
  );
}

/** Settings → Account security: the member's own sign-in, and for owners and admins the business's. */
export function SecurityPage() {
  const { t } = useI18n();
  const profile = useCurrentProfile();
  const can = usePermissions();
  return (
    <>
      <PageHeader title={t('security.title')} description={t('security.description')} />
      <div className="settings-grid">
        <AccountTwoFactor />
        {can('organization:manage') && <BusinessSecurity />}
        {profile.role.key === 'owner' && <TeamTwoFactor />}
      </div>
    </>
  );
}
