/**
 * Mistinted cans (MVP 3): a can tinted to the wrong shade leaves sellable
 * stock, shows to every branch, and is sold at a discount with its actual
 * shade or written off. Its loss is what it cost less what it sold for.
 */
export const MISTINT_STATUSES = ['available', 'sold', 'written_off'] as const;
export type MistintStatus = (typeof MISTINT_STATUSES)[number];

export interface MistintView {
  readonly id: string;
  readonly status: MistintStatus;
  readonly store: { readonly id: string; readonly code: string; readonly name: string };
  readonly variant: {
    readonly id: string;
    readonly sku: string;
    readonly packSize: number;
    readonly unit: string;
    readonly label: string | null;
  };
  readonly product: { readonly id: string; readonly name: string };
  readonly brand: { readonly name: string };
  readonly quantity: number;
  /** The shade it actually is. */
  readonly shadeCode: string;
  readonly shadeName: string | null;
  /** The shade the customer wanted. */
  readonly intendedShade: string | null;
  readonly reason: string;
  /** Its cost when recorded; null without costs:read or without a cost. */
  readonly costPaise: number | null;
  /** What it sold for before GST, while sold; null otherwise. */
  readonly soldTaxablePaise: number | null;
  /** Cost less what it sold for (all of it when written off); null without costs:read, a cost, or a resolution. */
  readonly lossPaise: number | null;
  /** The bill it was sold on, while sold. */
  readonly invoice: { readonly id: string; readonly number: string } | null;
  readonly note: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly resolvedAt: string | null;
}

export interface MistintPage {
  readonly items: MistintView[];
  readonly total: number;
}

/** POST /mistinted-cans. */
export interface RecordMistintInput {
  readonly storeId: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly shadeCode: string;
  readonly shadeName?: string;
  readonly intendedShade?: string;
  readonly reason: string;
}

/**
 * The loss on a can: what it cost less what it sold for, or all of it when
 * written off; null while it waits, or when its cost is not known.
 */
export function mistintLoss(
  status: MistintStatus,
  costPaise: number | null,
  soldTaxablePaise: number | null,
): number | null {
  if (costPaise === null || status === 'available') return null;
  return costPaise - (soldTaxablePaise ?? 0);
}
