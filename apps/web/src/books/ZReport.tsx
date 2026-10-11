import { Badge, Button, Card } from '@paint/ui';
import { CASH_DENOMINATIONS_PAISE, type RegisterSessionView } from '@paint/shared';
import { useI18n } from '../i18n/i18n.js';
import { storeLabel } from '../stock/StoreSelect.js';
import { useStores } from '../stock/stores.js';
import { VARIANCE_TONE, varianceKind } from './day-end.js';
import './books.css';

/** "Short by ₹20.00", "Over by ₹5.00" or "Balanced", in the variance's colour. */
export function VarianceBadge({ variancePaise }: { readonly variancePaise: number }) {
  const { t, money } = useI18n();
  const kind = varianceKind(variancePaise);
  const amount = money(Math.abs(variancePaise));
  return (
    <Badge tone={VARIANCE_TONE[kind]}>
      {kind === 'balanced' ? t('books.session.balanced') : t(`books.session.${kind}`, { amount })}
    </Badge>
  );
}

/**
 * The closing report of a register session (spec §5.5): every figure of the
 * day's cash, the count by denomination and the other modes, one column wide
 * so it prints on an 80 mm thermal roll as well as on paper.
 */
export function ZReport({ session }: { readonly session: RegisterSessionView }) {
  const { t, label, money, dateTime } = useI18n();
  const store = useStores().data?.find((choice) => choice.id === session.storeId);
  // A closed session always has these (the database insists).
  const counted = Number(session.countedCashPaise);
  const variance = Number(session.variancePaise);
  const counts = session.denominations ?? {};
  const notes = CASH_DENOMINATIONS_PAISE.map(
    (value) => [value, counts[String(value)] ?? 0] as const,
  ).filter(([, count]) => count > 0);
  const rows: [string, string][] = [
    [t('books.session.openedBy'), session.openedBy],
    [t('books.session.openedAt'), dateTime(session.openedAt)],
    [t('books.zReport.closedBy'), String(session.closedBy)],
    [t('books.zReport.closedAt'), dateTime(String(session.closedAt))],
    [t('books.session.float'), money(session.openingFloatPaise)],
    [t('books.session.cashIn'), money(session.cashInPaise)],
    [t('books.session.cashOut'), money(session.cashOutPaise)],
    ...session.movements.map((movement): [string, string] => [
      `${label('registerMovements', movement.kind)} · ${movement.reason}`,
      money(movement.amountPaise),
    ]),
    [t('books.session.expected'), money(session.expectedCashPaise)],
    [t('books.session.counted'), money(counted)],
  ];
  return (
    <Card
      title={t('books.zReport.title')}
      actions={
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            window.print();
          }}
        >
          {t('books.zReport.print')}
        </Button>
      }
    >
      <article className="z-report" aria-label={t('books.zReport.title')}>
        <header className="z-report__head">
          <p className="z-report__title">{t('books.zReport.title')}</p>
          {store !== undefined && <p>{storeLabel(store)}</p>}
          <p>{t('books.session.title', { code: session.registerCode })}</p>
        </header>
        <dl className="z-report__rows">
          {rows.map(([name, value], index) => (
            <div key={index}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          <div className="z-report__variance">
            <dt>{t('books.session.variance')}</dt>
            <dd>
              <VarianceBadge variancePaise={variance} />
            </dd>
          </div>
        </dl>
        <p className="z-report__section">{t('books.session.denominations')}</p>
        <dl className="z-report__rows">
          {notes.map(([value, count]) => (
            <div key={value}>
              <dt>{t('books.zReport.times', { value: money(value), count })}</dt>
              <dd>{money(value * count)}</dd>
            </div>
          ))}
        </dl>
        <p className="z-report__section">{t('books.session.modes')}</p>
        <dl className="z-report__rows">
          {session.modeTotals.map((mode) => (
            <div key={mode.modeId}>
              <dt>{mode.name}</dt>
              <dd>{money(mode.inPaise - mode.outPaise)}</dd>
            </div>
          ))}
        </dl>
        {session.closingNote !== null && <p>{session.closingNote}</p>}
      </article>
    </Card>
  );
}
