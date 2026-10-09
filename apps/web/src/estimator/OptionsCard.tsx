import {
  ESTIMATE_TIERS,
  isTierProblem,
  variantTitle,
  type EstimateTier,
  type TierOutcome,
} from '@paint/shared';
import { Button, Card } from '@paint/ui';
import { useI18n } from '../i18n/i18n.js';
import type { PaintProduct } from './estimator-api.js';
import { ProductChooser } from './ProductChooser.js';

/** "Brand Product 4 l" for every pack of the products chosen, by variant id. */
export function packNames(products: readonly (PaintProduct | null)[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const product of products) {
    if (product === null) continue;
    for (const variant of product.variants) {
      names.set(variant.id, variantTitle(product.brand.name, product.name, variant));
    }
  }
  return names;
}

/** Good / better / best side by side: each tier's paint, its live packs and "Make quotation". */
export function OptionsCard({
  tiers,
  primer,
  putty,
  outcomes,
  busy,
  onTier,
  onPrimer,
  onPutty,
  onQuote,
}: {
  readonly tiers: Readonly<Record<EstimateTier, PaintProduct | null>>;
  readonly primer: PaintProduct | null;
  readonly putty: PaintProduct | null;
  readonly outcomes: readonly TierOutcome[];
  readonly busy: boolean;
  readonly onTier: (tier: EstimateTier, product: PaintProduct | null) => void;
  readonly onPrimer: (product: PaintProduct | null) => void;
  readonly onPutty: (product: PaintProduct | null) => void;
  readonly onQuote: (tier: EstimateTier) => void;
}) {
  const { t, label, money, number } = useI18n();
  const names = packNames([...Object.values(tiers), primer, putty]);
  const litres = (ml: number) => number(ml / 1000);
  return (
    <Card title={t('estimator.options.title')}>
      <div className="stack">
        <p className="muted">{t('estimator.products.hint')}</p>
        <div className="form-grid">
          <ProductChooser
            label={label('estimatePurposes', 'primer')}
            hint={t('estimator.products.primerHint')}
            type="primer"
            value={primer}
            onChange={onPrimer}
          />
          <ProductChooser
            label={label('estimatePurposes', 'putty')}
            hint={t('estimator.products.puttyHint')}
            type="putty"
            value={putty}
            onChange={onPutty}
          />
        </div>
        <div className="estimator-tiers">
          {ESTIMATE_TIERS.map((tier) => {
            const outcome = outcomes.find((candidate) => candidate.tier === tier);
            const tierName = label('estimateTiers', tier);
            return (
              <section key={tier} className="estimator-tier" aria-label={tierName}>
                <h3>{tierName}</h3>
                <ProductChooser
                  label={tierName}
                  value={tiers[tier]}
                  onChange={(product) => {
                    onTier(tier, product);
                  }}
                />
                {outcome === undefined ? (
                  <p className="muted">{t('estimator.options.empty')}</p>
                ) : isTierProblem(outcome) ? (
                  <p className="estimator-tier__problem">
                    {t(
                      outcome.problem === 'noCoverage'
                        ? 'estimator.options.noCoverage'
                        : 'estimator.options.noPacks',
                      {
                        what: label('estimatePurposes', outcome.purpose),
                      },
                    )}
                  </p>
                ) : (
                  <>
                    <ul className="estimator-tier__needs">
                      <li>{t('estimator.options.paint', { litres: litres(outcome.paintMl) })}</li>
                      {outcome.primerMl > 0 && (
                        <li>
                          {t('estimator.options.primer', { litres: litres(outcome.primerMl) })}
                        </li>
                      )}
                      {outcome.puttyGrams > 0 && (
                        <li>
                          {t('estimator.options.putty', { kg: number(outcome.puttyGrams / 1000) })}
                        </li>
                      )}
                    </ul>
                    <ul className="estimator-tier__lines">
                      {outcome.lines.map((line) => (
                        <li key={line.variantId}>
                          <span>
                            {t('estimator.options.line', {
                              quantity: line.quantity,
                              // Every line is a pack of a product chosen here.
                              name: String(names.get(line.variantId)),
                            })}
                          </span>
                          <span>{money(line.totalPaise)}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="estimator-tier__total">
                      <span>{t('estimator.options.total')}</span>
                      <strong>{money(outcome.totalPaise)}</strong>
                    </p>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        onQuote(tier);
                      }}
                    >
                      {t('estimator.options.quote', { tier: tierName })}
                    </Button>
                  </>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
