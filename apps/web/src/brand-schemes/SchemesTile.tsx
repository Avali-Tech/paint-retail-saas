import { Badge, Card } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { schemesKey, useSchemeText } from './scheme-parts.js';

/**
 * The dashboard's brand schemes tile (P2-M33): the running scheme nearest its next
 * slab and what brands still owe. Only for members who see purchasing, and only once
 * a scheme is running or something is owed; its own request, so the rest of the
 * dashboard never waits.
 */
export function SchemesTile() {
  const can = usePermissions();
  if (!can('purchasing:read')) return null;
  return <Figures />;
}

function Figures() {
  const api = useApi();
  const { t, money, compactMoney, number } = useI18n();
  const { amount } = useSchemeText();
  const overview = useQuery({
    queryKey: [...schemesKey, 'overview'],
    queryFn: ({ signal }) => api.schemes.overview(signal),
  });
  const data = overview.data;
  if (data === undefined || (data.activeSchemes === 0 && data.outstandingPaise === 0)) return null;
  const { nearest } = data;
  return (
    <Card className="tile">
      <h2 className="tile__title">{t('schemes.tile.title')}</h2>
      <p className="tile__value">
        <span title={money(data.outstandingPaise)}>{compactMoney(data.outstandingPaise)}</span>
      </p>
      <div className="tile__details">
        <span className="muted">{t('schemes.tile.outstanding')}</span>
        {data.overdueClaims > 0 && (
          <Badge tone="danger">
            {t('schemes.tile.overdue', { count: number(data.overdueClaims) })}
          </Badge>
        )}
        {nearest !== null && (
          <span>
            {t('schemes.tile.nearest', {
              scheme: `${nearest.brandName} · ${nearest.schemeName}`,
              distance: amount(nearest.measure, nearest.distance),
              days: number(nearest.remainingDays),
            })}
          </span>
        )}
        <Link to="/brand-schemes">{t('schemes.tile.open')}</Link>
      </div>
    </Card>
  );
}
