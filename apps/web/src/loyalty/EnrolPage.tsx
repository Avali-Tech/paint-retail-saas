import { Alert, Button, Card, PageHeader, useToast } from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../api/errors.js';
import type { Party } from '../api/parties.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { PartyPicker } from '../parties/PartyPicker.js';
import { SalespersonField } from './SalespersonField.js';

/** /loyalty/new (the "+ Loyalty" quick action): choose a painter or contractor, then enrol them. */
export function EnrolPage() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [party, setParty] = useState<Party | null>(null);
  const [salesperson, setSalesperson] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: SyntheticEvent, chosen: Party) => {
    event.preventDefault();
    setMessage(null);
    setPending(true);
    try {
      await api.loyalty.enrol(chosen.id, salesperson === '' ? undefined : salesperson);
      await queryClient.invalidateQueries({ queryKey: ['party', chosen.id] });
      toast({ title: t('loyalty.enrolled'), tone: 'success' });
      void navigate(`/parties/${chosen.id}`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <PageHeader title={t('loyalty.enrolTitle')} description={t('loyalty.enrolHint')} />
      {party === null ? (
        <PartyPicker
          title={t('loyalty.chooseCustomer')}
          onPick={(chosen) => {
            setParty(chosen);
            setMessage(null);
          }}
        />
      ) : (
        <Card
          title={party.displayName}
          actions={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setParty(null);
              }}
            >
              {t('loyalty.chooseSomeoneElse')}
            </Button>
          }
        >
          <form
            className="stack"
            noValidate
            onSubmit={(event) => {
              void submit(event, party);
            }}
          >
            {message !== null && <Alert tone="danger">{message}</Alert>}
            <SalespersonField value={salesperson} onChange={setSalesperson} />
            <div className="row row--end">
              <Button type="submit" loading={pending}>
                {t('loyalty.enrolSubmit')}
              </Button>
            </div>
          </form>
        </Card>
      )}
    </>
  );
}
