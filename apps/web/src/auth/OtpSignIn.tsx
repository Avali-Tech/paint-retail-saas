import { zodResolver } from '@hookform/resolvers/zod';
import { normalizePhone } from '@paint/shared';
import { Alert, Button, Field, Input } from '@paint/ui';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, errorMessage, type BusinessChoice } from '../api/errors.js';
import type { SignInResult } from '../api/types.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { ChooseBusiness } from './ChooseBusiness.js';
import { showApiError } from './forms.js';

interface PhoneValues {
  phone: string;
}

interface CodeValues {
  code: string;
}

/**
 * Sign-in with a code texted to the mobile number: enter the number, then the
 * 6-digit code. Counter staff often have no password, so this is their usual way in.
 */
export function OtpSignIn({
  onSignedIn,
}: {
  /** A session, or the two-factor step that comes first. */
  readonly onSignedIn: (result: SignInResult) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const [phone, setPhone] = useState<string | null>(null);
  const [business, setBusiness] = useState<BusinessChoice | null>(null);
  const [businesses, setBusinesses] = useState<readonly BusinessChoice[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const phoneSchema = useMemo(
    () =>
      z.object({
        phone: z.string().refine((value) => normalizePhone(value) !== null, t('auth.invalidPhone')),
      }),
    [t],
  );
  const codeSchema = useMemo(
    () =>
      z.object({
        code: z
          .string()
          .trim()
          .regex(/^\d{6}$/, t('auth.invalidCode')),
      }),
    [t],
  );
  const phoneForm = useForm<PhoneValues>({
    resolver: zodResolver(phoneSchema),
    defaultValues: { phone: '' },
  });
  const codeForm = useForm<CodeValues>({
    resolver: zodResolver(codeSchema),
    defaultValues: { code: '' },
  });

  const sendCode = async (number: string) => {
    setMessage(null);
    try {
      await api.auth.requestOtp(number);
      setPhone(number);
    } catch (error) {
      setMessage(showApiError(error, ['phone'], phoneForm.setError));
    }
  };

  const verify = async (code: string, organizationId: string | undefined) => {
    setMessage(null);
    try {
      onSignedIn(await api.auth.verifyOtp({ phone: String(phone), code, organizationId }));
    } catch (error) {
      if (error instanceof ApiError && error.organizations.length > 0) {
        setBusinesses(error.organizations);
        return;
      }
      codeForm.reset();
      setMessage(errorMessage(error));
    }
  };

  if (phone === null) {
    const { errors, isSubmitting } = phoneForm.formState;
    return (
      <form
        className="stack"
        noValidate
        aria-label={t('auth.otp')}
        onSubmit={(event) => {
          void phoneForm.handleSubmit(({ phone: number }) => sendCode(number.trim()))(event);
        }}
      >
        {message !== null && <Alert tone="danger">{message}</Alert>}
        <Field label={t('auth.phone')} hint={t('auth.phoneHint')} error={errors.phone?.message}>
          <Input type="tel" inputMode="tel" autoComplete="tel" {...phoneForm.register('phone')} />
        </Field>
        <Button type="submit" loading={isSubmitting}>
          {t('auth.sendCode')}
        </Button>
      </form>
    );
  }

  const { errors, isSubmitting } = codeForm.formState;
  return (
    <form
      className="stack"
      noValidate
      aria-label={t('auth.otp')}
      onSubmit={(event) => {
        void codeForm.handleSubmit(({ code }) => verify(code, business?.id))(event);
      }}
    >
      <p>{t('auth.codeSentTo', { phone })}</p>
      {message !== null && <Alert tone="danger">{message}</Alert>}
      <Field label={t('auth.code')} error={errors.code?.message}>
        <Input
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          {...codeForm.register('code')}
        />
      </Field>
      <Button type="submit" loading={isSubmitting}>
        {t('auth.verify')}
      </Button>
      <div className="row">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void sendCode(phone);
          }}
        >
          {t('auth.resend')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setPhone(null);
            setBusiness(null);
            setMessage(null);
            codeForm.reset();
          }}
        >
          {t('auth.changeNumber')}
        </Button>
      </div>
      <ChooseBusiness
        businesses={businesses}
        onCancel={() => {
          setBusinesses([]);
        }}
        onChoose={(choice) => {
          // The API keeps the code until a business is chosen: send the same one again with it.
          setBusinesses([]);
          setBusiness(choice);
          void verify(codeForm.getValues('code').trim(), choice.id);
        }}
      />
    </form>
  );
}
