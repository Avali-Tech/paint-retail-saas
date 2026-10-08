import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Select,
  Table,
} from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Store } from '../api/stock.js';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { parseRupees } from '../lib/inputs.js';
import { QueryState } from '../lib/QueryState.js';
import { storeLabel, useStoreAccess } from '../stock/StoreSelect.js';
import { useStores } from '../stock/stores.js';
import { VARIANCE_TONE, varianceKind } from './day-end.js';

const CODE = /^[A-Z0-9-]{1,20}$/;
export const SESSIONS_SHOWN = 30;

/** Opens a register at the store with a float, then goes to its session. */
function OpenRegister({ store }: { readonly store: Store }) {
  const api = useApi();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [code, setCode] = useState('COUNTER-1');
  const [float, setFloat] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ code?: string; float?: string }>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const register = code.trim().toUpperCase();
    const floatPaise = parseRupees(float);
    const problems = {
      ...(CODE.test(register) ? {} : { code: t('books.registers.codeInvalid') }),
      ...(floatPaise === null || floatPaise < 0
        ? { float: t('books.registers.floatInvalid') }
        : {}),
    };
    setErrors(problems);
    setMessage(null);
    if (floatPaise === null || Object.keys(problems).length > 0) return;
    setPending(true);
    try {
      const session = await api.books.openRegister(register, {
        storeId: store.id,
        openingFloatPaise: floatPaise,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      await navigate(`/registers/${session.id}`);
    } catch (error) {
      setMessage(errorMessage(error));
      setPending(false);
    }
  };

  return (
    <Card title={t('books.registers.openTitle')}>
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {message !== null && <Alert tone="danger">{message}</Alert>}
        <div className="form-grid">
          <Field
            label={t('books.registers.code')}
            hint={t('books.registers.codeHint')}
            error={errors.code}
          >
            <Input
              className="uppercase"
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
              }}
            />
          </Field>
          <Field label={t('books.registers.float')} error={errors.float}>
            <Input
              inputMode="decimal"
              value={float}
              onChange={(event) => {
                setFloat(event.target.value);
              }}
            />
          </Field>
          <Field label={t('books.registers.note')}>
            <Input
              value={note}
              maxLength={300}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </Field>
        </div>
        <div className="row row--end">
          <Button type="submit" loading={pending}>
            {t('books.registers.open')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** The store's sessions, newest first. */
function Sessions({ store }: { readonly store: Store }) {
  const api = useApi();
  const { t, label, money, dateTime } = useI18n();
  const sessions = useQuery({
    queryKey: ['register-sessions', store.id],
    queryFn: ({ signal }) =>
      api.books.registers({ storeId: store.id, limit: SESSIONS_SHOWN, offset: 0 }, signal),
  });
  return (
    <Card title={t('books.registers.sessions')}>
      <QueryState query={sessions} error="books.registers.error">
        {(page) =>
          page.items.length === 0 ? (
            <p className="muted">{t('books.registers.empty')}</p>
          ) : (
            <Table label={t('books.registers.sessions')}>
              <thead>
                <tr>
                  <th scope="col">{t('books.registers.code')}</th>
                  <th scope="col">{t('books.registers.status')}</th>
                  <th scope="col">{t('books.registers.openedAt')}</th>
                  <th scope="col">{t('books.registers.closedAt')}</th>
                  <th scope="col">{t('books.registers.variance')}</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((session) => (
                  <tr key={session.id}>
                    <th scope="row">
                      <Link to={`/registers/${session.id}`}>{session.registerCode}</Link>
                    </th>
                    <td>
                      <Badge tone={session.status === 'open' ? 'success' : 'neutral'}>
                        {label('registerStatuses', session.status)}
                      </Badge>
                    </td>
                    <td>{dateTime(session.openedAt)}</td>
                    <td>
                      {session.closedAt === null ? t('common.none') : dateTime(session.closedAt)}
                    </td>
                    <td>
                      {session.variancePaise === null ? (
                        t('common.none')
                      ) : (
                        <Badge tone={VARIANCE_TONE[varianceKind(session.variancePaise)]}>
                          {money(session.variancePaise)}
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryState>
    </Card>
  );
}

/** /registers — the day end (spec §5.5): open a register, and every session of the store. */
export function RegistersPage() {
  const { t } = useI18n();
  const stores = useStores();
  const access = useStoreAccess();
  const [chosen, setChosen] = useState('');
  return (
    <>
      <PageHeader
        title={t('books.registers.title')}
        description={t('books.registers.description')}
      />
      <QueryState query={stores} error="books.registers.error">
        {(list) => {
          const choices = list.filter(
            (store) => store.isActive && store.type === 'store' && access(store.id),
          );
          const store = choices.find((choice) => choice.id === chosen) ?? choices[0];
          if (store === undefined) {
            return (
              <EmptyState
                icon={<Icon name="store" size={32} />}
                title={t('books.registers.title')}
                description={t('books.registers.noStore')}
              />
            );
          }
          return (
            <div className="stack">
              {choices.length > 1 && (
                <Field label={t('books.registers.store')} className="store-picker">
                  <Select
                    value={store.id}
                    onChange={(event) => {
                      setChosen(event.target.value);
                    }}
                  >
                    {choices.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {storeLabel(choice)}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <OpenRegister key={`open-${store.id}`} store={store} />
              <Sessions store={store} />
            </div>
          );
        }}
      </QueryState>
    </>
  );
}
