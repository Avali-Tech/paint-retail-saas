import type {
  SchemeBenefitView,
  SchemeProgress,
  SchemeStatus,
  SchemeView,
  SlabMeasure,
} from '@paint/shared';
import { Badge, type Tone } from '@paint/ui';
import { useI18n } from '../i18n/i18n.js';

// Pieces the brand scheme screens share: amounts in the scheme's measure, benefits in
// words, the status badge and the progress bar.

export const schemesKey = ['brand-schemes'] as const;

const STATUS_TONES: Record<SchemeStatus, Tone> = {
  draft: 'neutral',
  active: 'info',
  closed: 'success',
  cancelled: 'neutral',
};

/** Amounts as people read them: rupees for a value scheme, litres for a litres one. */
export function useSchemeText() {
  const { t, money, number, plural } = useI18n();
  const amount = (measure: SlabMeasure, value: number) =>
    measure === 'value' ? money(value) : t('schemes.litres', { litres: number(value / 1000) });
  const benefit = (item: SchemeBenefitView) => {
    switch (item.kind) {
      case 'rebate':
        return t('schemes.benefit.rebate', { percent: number(item.basisPoints / 100) });
      case 'per_litre':
        return t('schemes.benefit.perLitre', { amount: money(item.paisePerLitre) });
      case 'free_goods': {
        const units = plural('schemes.units', item.units);
        // The API names every free pack.
        const pack = String(item.variantTitle);
        return item.perMillilitres === null
          ? t('schemes.benefit.freeGoods', { units, pack })
          : t('schemes.benefit.freeGoodsPer', {
              units,
              pack,
              litres: number(item.perMillilitres / 1000),
            });
      }
      case 'points':
        return t('schemes.benefit.points', { points: number(item.points), label: item.label });
    }
  };
  /** "₹X to the next slab, ₹Y a day needed", or where the scheme ended up. */
  const nextSlab = (scheme: SchemeView, progress: SchemeProgress) => {
    const { next } = progress;
    if (next === null) return t('schemes.progress.topReached');
    const distance = amount(scheme.measure, next.distance);
    return next.perDayNeeded === null
      ? t('schemes.progress.shortBy', { distance, slab: number(next.index + 1) })
      : t('schemes.progress.toNext', {
          distance,
          slab: number(next.index + 1),
          perDay: amount(scheme.measure, next.perDayNeeded),
        });
  };
  return { amount, benefit, nextSlab };
}

export function SchemeStatusBadge({ status }: { readonly status: SchemeStatus }) {
  const { label } = useI18n();
  return <Badge tone={STATUS_TONES[status]}>{label('schemeStatus', status)}</Badge>;
}

/** How far the scheme has come toward its next slab (or its top slab, once reached). */
export function SchemeProgressBar({
  scheme,
  progress,
}: {
  readonly scheme: SchemeView;
  readonly progress: SchemeProgress;
}) {
  const { t } = useI18n();
  const { amount } = useSchemeText();
  // Past the top slab the bar is full.
  const goal = progress.next?.target ?? progress.achieved;
  const percent = Math.min(100, Math.floor((progress.achieved * 100) / goal));
  return (
    <div
      className="scheme-progress"
      role="progressbar"
      aria-label={t('schemes.progress.label', {
        achieved: amount(scheme.measure, progress.achieved),
        target: amount(scheme.measure, goal),
      })}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div
        className={
          progress.next === null
            ? 'scheme-progress__bar scheme-progress__bar--reached'
            : 'scheme-progress__bar'
        }
        style={{ width: `${String(percent)}%` }}
      />
    </div>
  );
}
