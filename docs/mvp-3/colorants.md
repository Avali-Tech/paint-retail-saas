# Colorant stock: tinting takes colorant out of stock (round 8a)

Until now a tint record kept a shade's formula as text and the colorant's cost per pack as money,
but no colorant left stock. Round 8a follows the product owner's decisions:

- Colorants are **stocked loose, by the ml or by the g**: a product of type `colorant` with a size /
  pack of 1 ml or 1 g. A can of colorant bought from the brand is received as its ml or g.
- **Short stock never stops the counter.** The can is billed, what the store has is taken, the
  shortfall is noted and the store's stock staff are told.
- **One shot size and one Y size per business**, in ml (Settings → Tinting).

Migration 0092 adds the data model (§4).

## 1. Naming the colorant in a formula

Each formula row of a tint (quote, order or invoice line) may name the colorant variant it is
dosed from (`formula.N.colorantVariantId`). The tint panel shows **Colorant N taken from** once
the business has a loose colorant, with **Not from stock** as the default, so old habits and old
tints keep working: a row without a colorant variant takes nothing.

The API refuses a variant that is not a loose colorant (type `colorant`, size 1, unit ml or g), as
a field error on `formula.N.colorantVariantId`: "Choose a colorant stocked loose, by the ml or by
the g".

## 2. How much one pack takes

`colorantDose` (`packages/shared/src/colorant-dose.ts`) turns a row's dose into the colorant's own
unit, rounded to 3 decimals like all stock:

| Dose in | Colorant stocked by the ml | Colorant stocked by the g |
| ------- | -------------------------- | ------------------------- |
| ml      | as is                      | ml × density              |
| g       | g ÷ density                | as is                     |
| shot    | shots × shot ml            | shots × shot ml × density |
| Y       | Y × Y ml                   | Y × Y ml × density        |

Density is the colorant pack's **density (g per ml)**, above 0 and up to 25, set on the size /
pack. A dose that needs a setting not yet made (shot ml, Y ml or density) takes nothing and is
reported (§3).

## 3. When colorant leaves stock

Colorant leaves with the tinted packs, beside the base's own sale, as `tint_use` movements
referencing the same document:

- **On invoice issue**, when the business posts stock on the invoice.
- **On dispatch**, when it posts stock on dispatch: each dispatch takes the share of the tinted
  packs it carries (tinted packs × packs dispatched ÷ packs on the line).

The store's colorant balances are locked while the use is worked out, so two bills cannot both take
the last of a colorant. When the store has less than the dose, what it has is taken and the
movement's note says "short by N ml". Short stock and missing settings send one `colorant_short`
notification per bill or dispatch to the store's `inventory:manage` members, linking the invoice,
so a receipt or a stock count can put it right.

Colorant is **never given back**: cancelling an invoice or taking a return does not reverse
`tint_use`, because the colorant is in the can.

## 4. Data model (migration 0092)

- `product_type` gains `colorant`; `stock_movement_type` gains `tint_use` (always negative);
  `notification_event` gains `colorant_short`.
- `product_variants.density_g_per_ml numeric(7,4)`, null or above 0 and up to 25.
- `sales_settings.tint_shot_ml` and `tint_y_ml`, null or above 0.
- `stock_ledger_quantity_sign` compares the movement type as text, because a new enum value cannot
  be used in the transaction that adds it (as migration 0072 did).

## 5. Screens

- **Products:** the type list has Colorant; a size / pack has **Density (g per ml)**.
- **Settings → Tinting** (`/settings/tinting`, `organization:manage`): one shot and one Y, in ml,
  up to 100 with at most 4 decimals; blank means not set.
- **Tint panel:** Colorant N taken from (§1).
- **Stock movements report:** `tint_use` reads "Colorant used in tinting".
