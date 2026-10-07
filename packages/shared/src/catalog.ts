/**
 * GST rate slabs in percent. Paints are 18% (HSN 3208-3210). Kept as data so a
 * change in law is a one-line change. Stored in the database as basis points.
 */
export const GST_RATES_PERCENT = [0, 5, 12, 18, 28, 40] as const;

/** 18% -> 1800 basis points. */
export function percentToBasisPoints(percent: number): number {
  return Math.round(percent * 100);
}

export function basisPointsToPercent(basisPoints: number): number {
  return basisPoints / 100;
}

const HSN_FORMAT = /^\d{4}(?:\d{2}){0,2}$/;

/** True for a 4, 6 or 8-digit HSN code, e.g. 3209 or 32091090. */
export function isValidHsn(hsn: string): boolean {
  return HSN_FORMAT.test(hsn);
}

/** True when a numeric GTIN (EAN-8, UPC-A, EAN-13, GTIN-14) has a correct check digit. */
export function isValidGtin(code: string): boolean {
  if (!/^(?:\d{8}|\d{12,14})$/.test(code)) return false;
  const digits = Array.from({ length: code.length }, (_, index) => Number(code.charAt(index)));
  const check = digits.pop();
  const sum = digits
    .reverse()
    .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

const INTERNAL_CODE = /^[A-Za-z0-9-]{4,48}$/;

/**
 * True for a barcode we can store: any 4-48 character internal code, except
 * that numbers shaped like EAN/UPC must have a valid check digit, which
 * catches most scanner and typing mistakes.
 */
export function isValidBarcode(code: string): boolean {
  if (/^(?:\d{8}|\d{12,14})$/.test(code)) return isValidGtin(code);
  return INTERNAL_CODE.test(code);
}

/** Longest variant label, e.g. "2 inch", "Grit 120", "48 mm" or "Red". */
export const VARIANT_LABEL_MAX_LENGTH = 40;

/** What a variant is: its pack size and unit, and the label that tells same-sized packs apart. */
export interface VariantSize<U extends string = string> {
  readonly packSize: number;
  readonly unit: U;
  readonly label?: string | null;
}

/** A label as stored: trimmed, and blank means no label (null). */
export function normalizeVariantLabel(label: string | null | undefined): string | null {
  const trimmed = label?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * How a variant is named after its product: "1 l" without a label; just the label for
 * single pieces ("2 inch" brush, "Grit 120" sandpaper); otherwise the label, then the
 * size ("Red · 1 l", "48 mm · 6 piece"). `unitName` translates the unit for display.
 */
export function variantName<U extends string>(
  variant: VariantSize<U>,
  unitName: (unit: U) => string = (unit) => unit,
): string {
  const size = `${String(variant.packSize)} ${unitName(variant.unit)}`;
  const label = normalizeVariantLabel(variant.label);
  if (label === null) return size;
  if (variant.unit === 'piece' && variant.packSize === 1) return label;
  return `${label} · ${size}`;
}

/**
 * "Berger WeatherCoat Long Life" from the brand and the product's name, without saying the
 * brand twice when the name already starts with it ("Berger Wall Putty", not "Berger Berger
 * Wall Putty"): catalogues and spreadsheets often name products that way.
 */
export function productTitle(brand: string, product: string): string {
  const prefix = `${brand.toLocaleLowerCase()} `;
  const repeatsBrand =
    product.toLocaleLowerCase() === brand.toLocaleLowerCase() ||
    product.toLocaleLowerCase().startsWith(prefix);
  return repeatsBrand ? product : `${brand} ${product}`;
}

/** A variant in full, e.g. "Asian Paints Apex Ultima 10 l" or "Asian Paints Brush 2 inch". */
export function variantTitle<U extends string>(
  brand: string,
  product: string,
  variant: VariantSize<U>,
  unitName?: (unit: U) => string,
): string {
  return `${productTitle(brand, product)} ${variantName(variant, unitName)}`;
}
