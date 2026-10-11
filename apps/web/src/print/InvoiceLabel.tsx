import type { InvoiceLabels, InvoiceView, PrintLabel, TintView } from '@paint/shared';

/** The second language's `lang` value, so screen readers and fonts pick the right script. */
export function translationLang(view: InvoiceView): string | undefined {
  return view.secondLanguage ?? undefined;
}

/** A printed label: English, with the chosen second language under it. */
export function InvoiceLabel({
  label,
  lang,
}: {
  readonly label: PrintLabel;
  readonly lang: string | undefined;
}) {
  return (
    <>
      {label.text}
      {label.translation !== null && (
        <>
          {' '}
          <span className="invoice__translation" lang={lang}>
            {label.translation}
          </span>
        </>
      )}
    </>
  );
}

/** The business's logo beside its name: decorative, since the name is always written. */
export function InvoiceLogo({ src }: { readonly src: string | null }) {
  return src === null ? null : <img className="invoice__logo" src={src} alt="" />;
}

/**
 * A line's tint as printed under it: in full on A4 ("Tint: X 132 · Ivory · Base: …
 * · Formula: XY 12 ml"), on one short line on a receipt (the line names its base).
 */
export function tintText(tint: TintView, labels: InvoiceLabels, compact: boolean): string {
  if (compact) {
    return [`${labels.tint.text} ${tint.shade}`, tint.formula].filter(Boolean).join(' · ');
  }
  return [
    `${labels.tint.text}: ${tint.shade}`,
    tint.base === null ? null : `${labels.base.text}: ${tint.base}`,
    tint.formula === null ? null : `${labels.formula.text}: ${tint.formula}`,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}
