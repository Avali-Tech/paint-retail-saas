import type { InvoiceView, PrintLabel } from '@paint/shared';

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
