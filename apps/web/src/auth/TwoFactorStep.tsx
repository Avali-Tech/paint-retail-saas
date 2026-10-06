import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, Field, Input, Spinner } from '@paint/ui';
import type { TwoFactorErrorCode } from '@paint/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, errorMessage } from '../api/errors.js';
import type { PendingSignIn, SessionGrant, TwoFactorEnrolment } from '../api/types.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { useBranding } from '../theme/BrandingProvider.js';
import { AuthenticatorSetup } from './AuthenticatorSetup.js';
import { RecoveryCodes } from './RecoveryCodes.js';

/** Why the API refused a code (its TwoFactorError body), or null for any other failure. */
export interface Refusal {
  readonly code: TwoFactorErrorCode;
  /** Tries left after a wrong code. */
  readonly attemptsRemaining: number;
}

/**
 * Reads a refused two-factor code: a wrong code while tries remain, or a
 * pending sign-in that can no longer be used (expired, used, or out of tries).
 * A 401 without a known code counts as expired.
 */
export function refusalOf(error: unknown): Refusal | null {
  if (!(error instanceof ApiError) || error.status !== 401) return null;
  const { code, attemptsRemaining } = error.body;
  if (code === 'wrong_code' && typeof attemptsRemaining === 'number') {
    return { code, attemptsRemaining };
  }
  return { code: code === 'too_many_attempts' ? code : 'expired', attemptsRemaining: 0 };
}

type CodeKind = 'app' | 'recovery';

interface CodeValues {
  code: string;
}

/** The code box: 6 digits from the app, or a recovery code. */
function CodeForm({
  kind,
  submitLabel,
  message,
  onSubmit,
}: {
  readonly kind: CodeKind;
  readonly submitLabel: string;
  readonly message: string | null;
  /** Sends the code; the box is cleared afterwards, ready for another try. */
  readonly onSubmit: (code: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const schema = useMemo(
    () =>
      z.object({
        code:
          kind === 'app'
            ? z
                .string()
                .trim()
                .regex(/^\d{6}$/, t('auth.invalidCode'))
            : z.string().trim().min(8, t('twoFactor.invalidRecovery')).max(20),
      }),
    [kind, t],
  );
  const form = useForm<CodeValues>({ resolver: zodResolver(schema), defaultValues: { code: '' } });
  const { errors, isSubmitting } = form.formState;
  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        void form.handleSubmit(async ({ code }) => {
          await onSubmit(code);
          form.reset();
        })(event);
      }}
    >
      {message !== null && <Alert tone="danger">{message}</Alert>}
      {kind === 'app' ? (
        <Field label={t('auth.code')} error={errors.code?.message}>
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            {...form.register('code')}
          />
        </Field>
      ) : (
        <Field
          label={t('twoFactor.recoveryCode')}
          hint={t('twoFactor.recoveryHint')}
          error={errors.code?.message}
        >
          <Input autoComplete="off" spellCheck={false} {...form.register('code')} />
        </Field>
      )}
      <Button type="submit" loading={isSubmitting}>
        {submitLabel}
      </Button>
    </form>
  );
}

export interface TwoFactorStepProps<G = SessionGrant> {
  readonly pending: PendingSignIn;
  readonly onSignedIn: (grant: G) => void;
  /** Back to the first step (password or mobile code). */
  readonly onRestart: () => void;
}

/** Where the codes go: the business's sign-in, or the platform console's. */
export interface TwoFactorCalls<G> {
  readonly setUp: (pendingToken: string) => Promise<TwoFactorEnrolment>;
  /** The session, and the recovery codes when an app was just added. */
  readonly verify: (
    pendingToken: string,
    code: string,
  ) => Promise<{ readonly grant: G; readonly recoveryCodes?: string[] }>;
}

/** Splits a sign-in answer into the session and the recovery codes that came with it. */
export function splitRecoveryCodes<G extends object>(
  answer: G & { readonly recoveryCodes?: string[] },
): { readonly grant: Omit<G, 'recoveryCodes'>; readonly recoveryCodes?: string[] } {
  const { recoveryCodes, ...grant } = answer;
  return recoveryCodes ? { grant, recoveryCodes } : { grant };
}

/** The business's two-factor step (POST /auth/2fa/setup and /auth/2fa/verify). */
export function TwoFactorStep(props: TwoFactorStepProps) {
  const api = useApi();
  return (
    <TwoFactorFlow
      {...props}
      calls={{
        setUp: api.twoFactor.setUp,
        verify: async (pendingToken, code) =>
          splitRecoveryCodes(await api.twoFactor.verify(pendingToken, code)),
      }}
    />
  );
}

/**
 * The second step of signing in: add an authenticator app first when the
 * business requires one, then a code from it (or a recovery code). The pending
 * sign-in lasts 5 minutes and takes 5 tries; after that the person starts over.
 */
export function TwoFactorFlow<G>({
  pending,
  onSignedIn,
  onRestart,
  calls,
}: TwoFactorStepProps<G> & { readonly calls: TwoFactorCalls<G> }) {
  const { t, plural } = useI18n();
  const { branding } = useBranding();
  const titleId = useId();
  const [kind, setKind] = useState<CodeKind>('app');
  const [timedOut, setTimedOut] = useState(false);
  /** Why the server ended the pending sign-in early (out of tries), in its words. */
  const [endedWith, setEndedWith] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState<{ grant: G; codes: string[] } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        setTimedOut(true);
      },
      Date.parse(pending.expiresAt) - Date.now(),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [pending.expiresAt]);

  const setup = useQuery({
    queryKey: ['two-factor-setup', pending.pendingToken],
    queryFn: () => calls.setUp(pending.pendingToken),
    enabled: pending.setupRequired,
    // One secret per pending sign-in: asking again would replace the one already scanned.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const setupRefused = setup.error instanceof ApiError && setup.error.status === 401;
  const expired = timedOut || setupRefused || endedWith !== null;

  const verify = async (code: string) => {
    setMessage(null);
    try {
      const { recoveryCodes, grant } = await calls.verify(pending.pendingToken, code);
      if (recoveryCodes) setSaving({ grant, codes: recoveryCodes });
      else onSignedIn(grant);
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal === null) {
        setMessage(errorMessage(error));
      } else if (refusal.code === 'wrong_code') {
        const left = refusal.attemptsRemaining;
        setMessage(plural('twoFactor.wrongCode', left));
      } else if (refusal.code === 'too_many_attempts') {
        setEndedWith(t('twoFactor.tooMany'));
      } else {
        setTimedOut(true);
      }
    }
  };

  if (saving !== null) {
    const { grant, codes } = saving;
    return (
      <RecoveryCodes
        codes={codes}
        onDone={() => {
          onSignedIn(grant);
        }}
      />
    );
  }

  if (expired) {
    return (
      <Alert
        tone="warning"
        action={
          <Button variant="secondary" onClick={onRestart}>
            {t('twoFactor.signInAgain')}
          </Button>
        }
      >
        {endedWith ?? t('twoFactor.expired')}
      </Alert>
    );
  }

  const intro = pending.setupRequired
    ? t('twoFactor.setupIntro')
    : kind === 'app'
      ? t('twoFactor.intro', { appName: branding.appName })
      : t('twoFactor.recoveryIntro');
  return (
    <section className="stack" aria-labelledby={titleId}>
      <h2 id={titleId} className="section-title">
        {pending.setupRequired ? t('twoFactor.setupTitle') : t('twoFactor.title')}
      </h2>
      <p>{intro}</p>
      {pending.setupRequired && setup.isPending && <Spinner label={t('common.loading')} />}
      {setup.isError && (
        <Alert
          tone="danger"
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void setup.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          }
        >
          {errorMessage(setup.error)}
        </Alert>
      )}
      {setup.data && <AuthenticatorSetup enrolment={setup.data} />}
      {(!pending.setupRequired || setup.data) && (
        <CodeForm
          key={kind}
          kind={kind}
          submitLabel={t('auth.verify')}
          message={message}
          onSubmit={verify}
        />
      )}
      <div className="row">
        {!pending.setupRequired && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMessage(null);
              setKind(kind === 'app' ? 'recovery' : 'app');
            }}
          >
            {kind === 'app' ? t('twoFactor.useRecovery') : t('twoFactor.useApp')}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onRestart}>
          {t('twoFactor.back')}
        </Button>
      </div>
    </section>
  );
}
