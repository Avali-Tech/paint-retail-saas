import { zodResolver } from '@hookform/resolvers/zod';
import { normalizePhone } from '@paint/shared';
import { Alert, Button, Field, Input } from '@paint/ui';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, errorMessage, type BusinessChoice } from '../api/errors.js';
import type { SessionGrant } from '../api/types.js';
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
export function OtpSignIn({ onSignedIn }: { readonly onSignedIn: (grant: SessionGrant) => void }) {
  const api = useApi();
  const { t } = useI18n();
  const [phone, setPhone] = useState<string | null>(null);
  const [business, setBusiness] = useState<BusinessChoice | null>(null);
  const [businesses, setBusinesses] = useState<readonly BusinessChoice[]>([]);
  const [message, setMessage] = useState<{ tone: 'danger' | 'info'; text: string } | null>(null);

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
      const text = showApiError(error, ['phone'], phoneForm.setError);
      if (text !== null) setMessage({ tone: 'danger', text });
    }
  };

  const verify = async ({ code }: CodeValues) => {
    setMessage(null);
    try {
      onSignedIn(
        await api.auth.verifyOtp({ phone: String(phone), code, organizationId: business?.id }),
      );
    } catch (error) {
      if (error instanceof ApiError && error.organizations.length > 0) {
        setBusinesses(error.organizations);
        return;
      }
      codeForm.reset();
      setMessage({ tone: 'danger', text: errorMessage(error) });
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
        {message !== null && <Alert tone={message.tone}>{message.text}</Alert>}
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
        void codeForm.handleSubmit(verify)(event);
      }}
    >
      <p>{t('auth.codeSentTo', { phone })}</p>
      {message !== null && <Alert tone={message.tone}>{message.text}</Alert>}
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
          // The API used up the code before asking which business, so a new code is needed.
          setBusinesses([]);
          setBusiness(choice);
          codeForm.reset();
          setMessage({ tone: 'info', text: t('auth.otpChooseAgain', { business: choice.name }) });
        }}
      />
    </form>
  );
}
