import { Alert, Button, Card, PageHeader, useToast } from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../api/errors.js';
import type { Party } from '../api/parties.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { PartyPicker } from '../parties/PartyPicker.js';
import { readRequest } from './CreditPanel.js';
import { refreshCredit } from './RequestDecision.js';
import { RequestFields, type RequestValues } from './RequestFields.js';

const EMPTY: RequestValues = { limit: '', days: '', note: '' };

/** /credit-requests/new (the "+ Credit request" quick action): choose a customer, then ask. */
export function NewCreditRequestPage() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [party, setParty] = useState<Party | null>(null);
  const [values, setValues] = useState<RequestValues>(EMPTY);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: SyntheticEvent, chosen: Party) => {
    event.preventDefault();
    setMessage(null);
    const read = readRequest(values.limit, values.days);
    if (typeof read === 'string') {
      setMessage(t(read === 'limit' ? 'credit.limitInvalid' : 'credit.daysInvalid'));
      return;
    }
    const note = values.note.trim();
    setPending(true);
    try {
      const created = await api.credit.request({
        partyId: chosen.id,
        ...read,
        ...(note === '' ? {} : { note }),
      });
      await refreshCredit(queryClient);
      toast({ title: t('credit.requested'), tone: 'success' });
      void navigate(`/credit-requests/${created.id}`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <PageHeader title={t('credit.requestTitle')} description={t('credit.requestHint')} />
      {party === null ? (
        <PartyPicker
          title={t('credit.chooseCustomer')}
          onPick={(chosen) => {
            setParty(chosen);
            setValues(EMPTY);
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
              {t('credit.chooseSomeoneElse')}
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
            <RequestFields values={values} onChange={setValues} />
            <div className="row row--end">
              <Button type="submit" loading={pending}>
                {t('credit.submit')}
              </Button>
            </div>
          </form>
        </Card>
      )}
    </>
  );
}
