import { formatFormula, formatShade, type LineTintView } from '@paint/shared';
import { useI18n } from '../i18n/i18n.js';

/**
 * A line's tint on a read-only quotation, order or invoice (spec §6.3): the shade,
 * the base it is tinted on (the line's own pack) and the formula, under the item.
 */
export function TintSummary({
  tint,
  base,
}: {
  readonly tint: LineTintView;
  /** The tinted base: the line's description; null leaves it out. */
  readonly base: string | null;
}) {
  const { t } = useI18n();
  const formula = formatFormula(tint.formula, (unit) => t(`tint.units.${unit}`));
  const parts = [
    t('tint.summary.shade', { shade: formatShade(tint.shadeCode, tint.shadeName) }),
    base === null ? null : t('tint.summary.base', { base }),
    formula === null ? null : t('tint.summary.formula', { formula }),
  ].filter((part) => part !== null);
  return <span className="cell-meta tint-summary">{parts.join(' · ')}</span>;
}
