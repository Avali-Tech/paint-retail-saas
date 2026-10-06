import { zodResolver } from '@hookform/resolvers/zod';
import { normalizeEmail, normalizePhone } from '@paint/shared';
import { Alert, Button, Card, Field, Input, PageHeader, useToast } from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { z } from 'zod';
import type { MemberInput } from '../api/team.js';
import { useApi } from '../app/services.js';
import { showApiError } from '../auth/forms.js';
import { useI18n, type I18n } from '../i18n/i18n.js';
import { AccessFields, accessProblems, type Access, type AccessErrors } from './AccessFields.js';
import { membersKey } from './team-data.js';

const blankOr = (check: (value: string) => boolean) => (value: string) =>
  value.trim() === '' || check(value);

function personSchema(t: I18n['t']) {
  return z
    .object({
      fullName: z
        .string()
        .trim()
        .min(2, t('team.form.nameInvalid'))
        .max(120, t('team.form.nameInvalid')),
      phone: z.string().refine(
        blankOr((value) => normalizePhone(value) !== null),
        t('team.form.phoneInvalid'),
      ),
      email: z.string().refine(
        blankOr((value) => normalizeEmail(value) !== null),
        t('team.form.emailInvalid'),
      ),
      password: z.string().refine(
        blankOr((value) => value.length >= 8),
        t('team.form.passwordInvalid'),
      ),
    })
    .refine((values) => values.phone.trim() !== '' || values.email.trim() !== '', {
      path: ['phone'],
      message: t('team.form.contactRequired'),
    });
}

type PersonValues = z.output<ReturnType<typeof personSchema>>;

const FIELDS = ['fullName', 'phone', 'email', 'password'] as const;

/** What POST /members takes: empty contact fields and the password are left out. */
export function toMemberInput(person: PersonValues, access: Access): MemberInput {
  const phone = person.phone.trim();
  const email = person.email.trim();
  return {
    fullName: person.fullName.trim(),
    ...(phone === '' ? {} : { phone }),
    ...(email === '' ? {} : { email }),
    ...(person.password === '' ? {} : { password: person.password }),
    roleId: access.roleId,
    allStores: access.allStores,
    storeIds: access.allStores ? [] : access.storeIds,
  };
}

/** /team/new — adds a person to the business with a role and stores. */
export function NewMemberPage() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const schema = useMemo(() => personSchema(t), [t]);
  const form = useForm<PersonValues>({
    resolver: zodResolver(schema),
    defaultValues: { fullName: '', phone: '', email: '', password: '' },
  });
  const [access, setAccess] = useState<Access>({ roleId: '', allStores: false, storeIds: [] });
  const [accessErrors, setAccessErrors] = useState<AccessErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const { errors, isSubmitting } = form.formState;

  const save = async (person: PersonValues) => {
    setMessage(null);
    try {
      const member = await api.team.addMember(toMemberInput(person, access));
      await queryClient.invalidateQueries({ queryKey: membersKey });
      toast({ title: t('team.form.added', { name: member.user.fullName }), tone: 'success' });
      void navigate(`/team/${member.id}`);
    } catch (error) {
      setMessage(showApiError(error, FIELDS, form.setError));
    }
  };

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        const problems = accessProblems(access, t);
        setAccessErrors(problems);
        void form.handleSubmit(async (person) => {
          if (Object.keys(problems).length === 0) await save(person);
        })(event);
      }}
    >
      <PageHeader
        title={t('team.form.title')}
        description={t('team.form.description')}
        actions={<Link to="/team">{t('team.member.back')}</Link>}
      />
      {message !== null && <Alert tone="danger">{message}</Alert>}
      <Card title={t('team.form.person')}>
        <div className="form-grid">
          <Field label={t('team.form.fullName')} error={errors.fullName?.message} required>
            <Input autoComplete="off" {...form.register('fullName')} />
          </Field>
          <Field
            label={t('team.form.phone')}
            hint={t('team.form.contactHint')}
            error={errors.phone?.message}
          >
            <Input type="tel" inputMode="tel" autoComplete="off" {...form.register('phone')} />
          </Field>
          <Field label={t('team.form.email')} error={errors.email?.message}>
            <Input type="email" autoComplete="off" {...form.register('email')} />
          </Field>
          <Field
            label={t('team.form.password')}
            hint={t('team.form.passwordHint')}
            error={errors.password?.message}
          >
            <Input type="password" autoComplete="new-password" {...form.register('password')} />
          </Field>
        </div>
      </Card>
      <Card title={t('team.member.access')}>
        <div className="stack">
          <AccessFields
            value={access}
            onChange={setAccess}
            errors={accessErrors}
            currentRoleId=""
            disabled={false}
          />
        </div>
      </Card>
      <div className="row">
        <Button type="submit" loading={isSubmitting}>
          {t('team.form.save')}
        </Button>
      </div>
    </form>
  );
}
