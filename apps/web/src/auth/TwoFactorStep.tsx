import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, Field, Input, Spinner } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, errorMessage } from '../api/errors.js';
import type { PendingSignIn, SessionGrant } from '../api/types.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { useBranding } from '../theme/BrandingProvider.js';
import { AuthenticatorSetup } from './AuthenticatorSetup.js';
import { RecoveryCodes } from './RecoveryCodes.js';

/** How many codes a pending sign-in accepts (CHALLENGE_MAX_ATTEMPTS in the API). */
export const TWO_FACTOR_TRIES = 5;

/**
 * The API's answer to a wrong code while the pending sign-in can still be used;
 * any other 401 means it has expired, been used up or was never valid.
 */
const WRONG_CODE = 'Wrong code';

export const isWrongCode = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 401 && error.message === WRONG_CODE;

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

export interface TwoFactorStepProps {
  readonly pending: PendingSignIn;
  readonly onSignedIn: (grant: SessionGrant) => void;
  /** Back to the first step (password or mobile code). */
  readonly onRestart: () => void;
}

/**
 * The second step of signing in: add an authenticator app first when the
 * business requires one, then a code from it (or a recovery code). The pending
 * sign-in lasts 5 minutes and takes 5 tries; after that the person starts over.
 */
export function TwoFactorStep({ pending, onSignedIn, onRestart }: TwoFactorStepProps) {
  const api = useApi();
  const { t } = useI18n();
  const { branding } = useBranding();
  const titleId = useId();
  const [kind, setKind] = useState<CodeKind>('app');
  const [triesLeft, setTriesLeft] = useState(TWO_FACTOR_TRIES);
  const [timedOut, setTimedOut] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState<{ grant: SessionGrant; codes: string[] } | null>(null);

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
    queryFn: () => api.twoFactor.setUp(pending.pendingToken),
    enabled: pending.setupRequired,
    // One secret per pending sign-in: asking again would replace the one already scanned.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const setupRefused = setup.error instanceof ApiError && setup.error.status === 401;
  const expired = timedOut || setupRefused;

  const verify = async (code: string) => {
    setMessage(null);
    try {
      const { recoveryCodes, ...grant } = await api.twoFactor.verify(pending.pendingToken, code);
      if (recoveryCodes) setSaving({ grant, codes: recoveryCodes });
      else onSignedIn(grant);
    } catch (error) {
      if (isWrongCode(error) && triesLeft > 1) {
        const left = triesLeft - 1;
        setTriesLeft(left);
        setMessage(
          left === 1 ? t('twoFactor.wrongCodeLast') : t('twoFactor.wrongCode', { count: left }),
        );
      } else if (error instanceof ApiError && error.status === 401) {
        setTimedOut(true);
      } else {
        setMessage(errorMessage(error));
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
        {t('twoFactor.expired')}
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
