import { Badge, Button, Card, EmptyState, Field, Icon, Input } from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Party } from '../api/parties.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { useDebouncedValue } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';

export const PICKER_SIZE = 10;
export const PICKER_DELAY_MS = 300;

/**
 * Finds a customer (or any party) by name, mobile number or GSTIN and hands back
 * the one chosen; quick actions such as "+ Credit request" start here.
 */
export function PartyPicker({
  title,
  onPick,
}: {
  readonly title: string;
  readonly onPick: (party: Party) => void;
}) {
  const api = useApi();
  const { t, label } = useI18n();
  const [text, setText] = useState('');
  const q = useDebouncedValue(text.trim(), PICKER_DELAY_MS);
  const parties = useQuery({
    queryKey: ['parties', { q, picker: true }],
    queryFn: ({ signal }) => api.parties.list({ q, limit: PICKER_SIZE }, signal),
    enabled: q !== '',
    placeholderData: keepPreviousData,
  });
  return (
    <Card title={title}>
      <div className="stack">
        <Field label={t('parties.search')}>
          <Input
            type="search"
            autoFocus
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        </Field>
        {q === '' ? (
          <p className="muted">{t('parties.picker.hint')}</p>
        ) : (
          <QueryState query={parties} error="parties.error">
            {(page) =>
              page.items.length === 0 ? (
                <EmptyState
                  icon={<Icon name="customers" size={32} />}
                  title={t('parties.picker.none', { query: q })}
                />
              ) : (
                <ul className="record-list">
                  {page.items.map((party) => (
                    <li key={party.id} className="record-list__row">
                      <span className="picker__who">
                        <span className="record-list__title">{party.displayName}</span>
                        <span className="record-list__meta">
                          {[party.phone, party.city].filter((part) => part !== null).join(' · ')}
                        </span>
                        <span className="badges">
                          {party.roles.map((role) => (
                            <Badge key={role} tone="primary">
                              {label('partyRoles', role)}
                            </Badge>
                          ))}
                        </span>
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={t('parties.picker.chooseName', { name: party.displayName })}
                        onClick={() => {
                          onPick(party);
                        }}
                      >
                        {t('parties.picker.choose')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )
            }
          </QueryState>
        )}
      </div>
    </Card>
  );
}
