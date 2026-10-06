import { Alert, Button } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';

/**
 * Shown when a list keeps to one party (the customer 360's "See all" opens it
 * so): whose records these are, and a way back to everyone's.
 */
export function PartyFilterNote({
  partyId,
  onClear,
}: {
  readonly partyId: string;
  readonly onClear: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const party = useQuery({
    queryKey: ['parties', partyId],
    queryFn: ({ signal }) => api.parties.get(partyId, signal),
  });
  return (
    <div className="page-notice">
      <Alert
        tone="info"
        action={
          <Button size="sm" variant="ghost" onClick={onClear}>
            {t('crm.allParties')}
          </Button>
        }
      >
        {t('crm.forParty', { name: party.data?.displayName ?? t('common.loading') })}
      </Alert>
    </div>
  );
}
