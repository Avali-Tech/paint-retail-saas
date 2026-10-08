import type { QuotationView, SalesOrderView } from '@paint/shared';
import { Card } from '@paint/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../i18n/i18n.js';
import { stateLabel } from '../lib/gst-states.js';

/**
 * Who a quotation or order is for (spec §6.4): bill-to (who pays and owes), the
 * influencer who brought the sale, the site and where the goods go.
 */
export function DocumentFacts({
  document,
  badge,
  storeName,
  extra = [],
}: {
  readonly document: QuotationView | SalesOrderView;
  readonly badge: ReactNode;
  readonly storeName: string | null;
  /** More facts after these, e.g. payment terms. */
  readonly extra?: readonly (readonly [string, ReactNode])[];
}) {
  const { t } = useI18n();
  const none = t('common.none');
  const { billTo, shipTo } = document;
  const ship = [
    shipTo.name,
    shipTo.address,
    shipTo.stateCode === null ? null : stateLabel(shipTo.stateCode),
  ].filter((part) => part !== null);
  const facts: (readonly [string, ReactNode])[] = [
    [t('orders.editor.store'), storeName ?? none],
    [
      t('orders.editor.billTo'),
      <Link key="bill-to" to={`/parties/${billTo.id}`}>
        {billTo.name}
      </Link>,
    ],
    [t('sales.invoice.gstin'), billTo.gstin ?? none],
    [t('orders.editor.influencer'), document.influencer?.name ?? none],
    [
      t('orders.editor.site'),
      document.project === null ? (
        none
      ) : (
        <Link key="site" to={`/projects/${document.project.id}`}>
          {document.project.name}
        </Link>
      ),
    ],
    [t('orders.editor.shipTo'), ship.length === 0 ? none : ship.join(', ')],
    [t('sales.invoice.placeOfSupply'), stateLabel(document.placeOfSupplyCode)],
    ...extra,
  ];
  if (document.note !== null) facts.push([t('orders.editor.note'), document.note]);
  return (
    <Card title={t('sales.invoice.details')} actions={badge}>
      <dl className="facts">
        {facts.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
