# Mistinted cans: record them, sell them at a discount, or write them off

A tinting mistake happens when staff type X110 instead of X101, or the machine over-doses. The can
is still a full can of paint, but no longer the shade anyone ordered. Until now it simply sat in
stock as the base, so the books thought it was sellable and nobody else knew it existed.

The product owner's decision: **the can leaves normal stock, shows to every branch, and is later
sold at a chosen price with its actual shade, or written off.** The loss is reported.

## 1. Recording one

**Stock → Mistinted cans → + Mistinted can** asks for:

- the store and the base pack it was tinted from, and the quantity;
- the shade it actually is (code, and optionally a name);
- the shade that was wanted;
- what went wrong.

Counter staff (`billing:issue`) or stock staff (`inventory:manage`) can record it, at a store they
work at. Recording takes the can out of sellable stock at once, as a `mistint` movement. Its cost
is the average cost × quantity at that moment. Without enough stock it is refused.

## 2. Every branch sees it

The list shows every branch's cans to anyone with `inventory:read`, filtered by store and status:
waiting to be sold, sold, or written off. A branch with a customer for an odd shade can see what
another branch has. Cost and loss are shown only with `costs:read`.

## 3. Selling one

**Sell at the counter** is offered on a can waiting at the member's own store. It opens the counter
with `?mistint=<id>`, which offers the can to the bill:

- The line is the base at its catalogue price, marked "Mistinted can: X110", for the cashier to
  discount. A discount needs `billing:discount`, as any discount does.
- The can is sold **whole**: its quantity cannot be changed, and it can be on a bill only once.
- On the API, a counter bill line may carry `mistintCanId`. Saving the draft checks the can:
  - it is still waiting to be sold,
  - it is at this store,
  - the line has the same pack and the whole quantity.
- **On issue**, the can comes back into stock (`mistint`, positive) and leaves as an ordinary
  `sale`. Sales reports count it like any sale, and the stock balance does not move twice. The can
  is marked sold, for the line's value before GST. A can sold or written off meanwhile makes issue
  fail with a conflict.
- **If the bill is cancelled**, the can goes back on the list, waiting to be sold, and out of
  sellable stock again.
- A held bill keeps its mistinted line.

## 4. Writing one off

Stock staff (`inventory:manage`) at the can's store write it off with a reason. All its cost is
the loss. It cannot be undone.

## 5. The loss

Loss = cost − what it sold for (before GST), or the whole cost when written off. A can still
waiting has no loss yet. It shows on the list (with `costs:read`). The report **Mistinted cans**
(`/reports/mistinted-cans`, by store and recorded date, CSV) gives each can's cost, sale and loss.
The cost and loss columns need `costs:read`.

## 6. Data model (migration 0096)

- `stock_movement_type` gains `mistint`, which may be either sign: out when recorded, in when sold
  or put back.
- New enum `mistint_status`: `available`, `sold`, `written_off`.
- New table `mistinted_cans`, with:
  - store, variant, quantity;
  - the actual shade, its name, and the wanted shade;
  - reason, cost, status;
  - the sold value before GST;
  - who resolved it and when, and the write-off note.

  Checks keep resolved exactly when not waiting, and a sale value only while sold. It has
  row-level security and is audited.

- `tax_document_lines.mistint_can_id` links the counter line that sells a can.
