import { Badge, type Tone } from '@paint/ui';
import type { ContractStatus, ContractSummary } from '../api/contracts.js';
import { useI18n } from '../i18n/i18n.js';

export const CONTRACT_TONE: Record<ContractStatus, Tone> = {
  draft: 'neutral',
  active: 'success',
  expired: 'warning',
  terminated: 'danger',
  renewed: 'info',
};

/** A contract's status, and "Renewal due" when its renewal date has come. */
export function ContractBadges({
  contract,
}: {
  readonly contract: Pick<ContractSummary, 'status' | 'renewalDue'>;
}) {
  const { t, label } = useI18n();
  return (
    <span className="badges">
      <Badge tone={CONTRACT_TONE[contract.status]}>
        {label('contractStatus', contract.status)}
      </Badge>
      {contract.renewalDue && <Badge tone="warning">{t('contracts.renewalDueBadge')}</Badge>}
    </span>
  );
}
