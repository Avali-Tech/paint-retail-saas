import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, Field, Input } from '@paint/ui';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, type BusinessChoice } from '../api/errors.js';
import type { SignInResult } from '../api/types.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { ChooseBusiness } from './ChooseBusiness.js';
import { showApiError } from './forms.js';

interface Values {
  identifier: string;
  password: string;
}

/** Mobile number or email and password; asks which business when there are several. */
export function PasswordSignIn({
  onSignedIn,
}: {
  /** A session, or the two-factor step that comes first. */
  readonly onSignedIn: (result: SignInResult) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const schema = useMemo(
    () =>
      z.object({
        identifier: z.string().trim().min(3, t('auth.required')),
        password: z.string().min(1, t('auth.required')),
      }),
    [t],
  );
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { identifier: '', password: '' },
  });
  const [message, setMessage] = useState<string | null>(null);
  const [businesses, setBusinesses] = useState<readonly BusinessChoice[]>([]);

  const signIn = async (values: Values, organizationId?: string) => {
    setMessage(null);
    try {
      onSignedIn(await api.auth.login({ ...values, organizationId }));
    } catch (error) {
      if (error instanceof ApiError && error.organizations.length > 0) {
        setBusinesses(error.organizations);
        return;
      }
      setMessage(showApiError(error, ['identifier', 'password'], form.setError));
    }
  };

  const { errors, isSubmitting } = form.formState;
  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        void form.handleSubmit((values) => signIn(values))(event);
      }}
      aria-label={t('auth.password')}
    >
      {message !== null && <Alert tone="danger">{message}</Alert>}
      <Field
        label={t('auth.identifier')}
        hint={t('auth.identifierHint')}
        error={errors.identifier?.message}
      >
        <Input autoComplete="username" inputMode="email" {...form.register('identifier')} />
      </Field>
      <Field label={t('auth.passwordLabel')} error={errors.password?.message}>
        <Input type="password" autoComplete="current-password" {...form.register('password')} />
      </Field>
      <Button type="submit" loading={isSubmitting}>
        {t('auth.signIn')}
      </Button>
      <ChooseBusiness
        businesses={businesses}
        onCancel={() => {
          setBusinesses([]);
        }}
        onChoose={(business) => {
          setBusinesses([]);
          void signIn(form.getValues(), business.id);
        }}
      />
    </form>
  );
}
