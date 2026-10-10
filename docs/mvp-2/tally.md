# Tally export (P2-M07): format notes

The pure mapper in `packages/shared/src/tally/` (round 2c, spec §6.1) turns a period's tax documents,
receipts, refunds and bounced cheques into TallyPrime import XML and an `.xlsx`. This page records the format choices and
where each comes from, so the pilot accountant's import (the round 2 demo) can confirm or correct
them. Spec §6.1 says the exact tag set is fixed against the pilot's TallyPrime release.

## Files

| File                                    | What it is                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `tally-sample-ledgers.xml`              | Ledger masters for the sample month. **Import this first** (`All Masters`)                                  |
| `tally-sample.xml`                      | The sample month's 62 vouchers (`Vouchers`): 40 invoices, 4 notes, 15 receipts, 2 refunds, 1 bounce journal |
| `.../tally/fixtures/sharma-*.xml/.xlsx` | The same files as golden fixtures; tests compare them byte for byte                                         |
| `.../fixtures/sharma-october-*`         | Early October: a September cheque bouncing in the next period (journal only) and a walk-in cash refund      |

The sample is "Sharma Paints & Hardware", September 2026: Ameerpet (`AMP`) and Kukatpally (`KKP`)
stores on one Telangana GSTIN, local contractors, walk-ins, and an Andhra Pradesh builder and home
owner billed IGST. It has an exempt line, one cancelled invoice, 3 credit notes, 1 debit note, and
receipts in cash, UPI, cheque and NEFT, one of them an advance. Two refunds go out (part of that
advance under a refund voucher, and part of an on-account remainder by NEFT), and one cheque bounces
with a ₹500 charge. To try it, create a company named
`Sharma Paints & Hardware` with GST enabled (Telangana), then use Import → Masters, then Import →
Transactions.

## Choices and sources

| Topic            | What we write                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Source                                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Envelope         | `HEADER/TALLYREQUEST` "Import Data"; `IMPORTDATA/REQUESTDESC/REPORTNAME` "Vouchers" or "All Masters"; `STATICVARIABLES/SVCURRENTCOMPANY`; `REQUESTDATA/TALLYMESSAGE`                                                                                                                                                                                                                                                                                                                                                | [Sample XML](https://help.tallysolutions.com/sample-xml/), [XML integration](https://help.tallysolutions.com/xml-integration/)                                                                                                                                     |
| Mode             | Accounting voucher view: `OBJVIEW` and `PERSISTEDVIEW` "Accounting Voucher View", `ISINVOICE` No, ledger lines in `ALLLEDGERENTRIES.LIST`, no stock items (spec §6.1, PO-8)                                                                                                                                                                                                                                                                                                                                         | [Sample XML](https://help.tallysolutions.com/sample-xml/) (voucher-mode sample and Note 2 on accounting invoices)                                                                                                                                                  |
| Debit and credit | Debit: `ISDEEMEDPOSITIVE` Yes and a **negative** `AMOUNT`. Credit: `ISDEEMEDPOSITIVE` No and a positive `AMOUNT`. Bill allocations take their line's sign                                                                                                                                                                                                                                                                                                                                                           | [Sample XML](https://help.tallysolutions.com/sample-xml/): "In sales voucher this should be set to YES for all debiting a ledger"; its sample has party `Yes` / `-21546.00`, sales `No` / `21546.00`                                                               |
| Which side       | Sale and debit note: Dr party = total; Cr sales per rate × supply type; Cr output tax per head and rate; round-off on the side that balances. Credit note: the mirror. Receipt: Dr mode ledger, Cr party. Refund (Payment): Dr party, Cr mode ledger. Bounce (Journal): Dr party, Cr mode ledger; a charge adds Dr party, Cr `Cheque Bounce Charges`                                                                                                                                                                | Spec §6.1 table, §4.6                                                                                                                                                                                                                                              |
| Bills            | Party lines carry `BILLALLOCATIONS.LIST` (`NAME`, `BILLTYPE`, `AMOUNT`). Invoices and debit notes are `New Ref` under their own number. Receipts and credit notes are `Agst Ref` per allocation; the rest is `On Account`, or `Advance` under the receipt voucher number. A refund is `Agst Ref` that advance (or `On Account`). A bounce is `Agst Ref` each bill its receipt settled, the rest as the refund, and its charge a `New Ref` under the bounce's number. The walk-in "Cash Sales" ledger keeps no bills | [Sample XML](https://help.tallysolutions.com/sample-xml/) (bill types Advance, Agst Ref, New Ref, On Account)                                                                                                                                                      |
| GST header       | `PARTYNAME`, `GSTREGISTRATIONTYPE` (Regular / Unregistered/Consumer), `PARTYGSTIN`, `STATENAME`, `COUNTRYOFRESIDENCE`, `PLACEOFSUPPLY` (state name), `CMPGSTIN`                                                                                                                                                                                                                                                                                                                                                     | [Schema changes in GST details (Release 3.0)](https://help.tallysolutions.com/what-are-the-changes-in-xml-tags/); registration types: [Tally help](https://help.tallysolutions.com/incorrect-registration-type-or-tax-ledger-is-selected-in-the-bank-transaction/) |
| Identity         | `REMOTEID="paint-<document id>"` on every voucher, so a re-import overwrites instead of duplicating; also `[paint:<document id>]` in the narration (spec §6.1)                                                                                                                                                                                                                                                                                                                                                      | [Import/export FAQ](https://help.tallysolutions.com/docs/faqs/faq/faq-import-and-export.htm)                                                                                                                                                                       |
| Dates, amounts   | `YYYYMMDD`; rupees from integer paise, two decimals, no grouping                                                                                                                                                                                                                                                                                                                                                                                                                                                    | [Sample XML](https://help.tallysolutions.com/sample-xml/): "All dates must follow the YYYYMMDD format"                                                                                                                                                             |
| Escaping         | `&amp; &lt; &gt; &quot; &apos;`; control characters XML 1.0 forbids are dropped. UTF-8                                                                                                                                                                                                                                                                                                                                                                                                                              | [Special characters FAQ](https://help.tallysolutions.com/article/DeveloperReference/faq/9228.html)                                                                                                                                                                 |
| Ledger masters   | `LEDGER NAME=… ACTION="Create"`, `NAME.LIST`, `PARENT` (a predefined group), `ISBILLWISEON`; parties add GSTIN, registration type, `LEDSTATENAME`; tax ledgers `TAXTYPE` GST, `GSTDUTYHEAD`, `RATEOFTAXCALCULATION`                                                                                                                                                                                                                                                                                                 | [Sample XML](https://help.tallysolutions.com/sample-xml/) (ledger create), [Set up tax ledgers for GST](https://help.tallysolutions.com/set-up-tax-ledgers-for-gst/)                                                                                               |

## Refunds and bounced cheques

| Event          | Voucher type | Number and date                                        | Identity                                                  |
| -------------- | ------------ | ------------------------------------------------------ | --------------------------------------------------------- |
| Refund paid    | `Payment`    | The refund voucher number (Rule 51) or `RF-…`; paid on | `paint-<payment id>`; `REFERENCE` = the receipt it repays |
| Cheque bounced | `Journal`    | `<receipt number>/BOUNCE`; the bounce date             | `paint-<payment id>-bounce`; `REFERENCE` = the receipt    |

A refund is money paid out of a cash, bank or clearing ledger, which is what TallyPrime's `Payment`
voucher is for (F5). A bounce is different: no money moves on the bounce date; the receipt we
exported is turned round. We keep that receipt as it was taken (with the bills it settled when it bounced, found by
`allocations.reversal_reason = 'cheque_bounce'`, so a receipt already imported does not change) and add a `Journal` (F7) on the bounce date.
Journal is the standard TallyPrime entry for a dishonoured cheque recorded by hand: it takes any
ledger on either side, so it works whether the cheque went to `Cheques in Hand` (a current asset,
which is not the cash or bank account a Payment voucher pays from) or straight to a bank ledger, and it
carries the bill-wise `Agst Ref` lines that reopen the invoices and the bounce charge in one
voucher. A bounce in a later period exports only its journal; its receipt went out with its own
period. The bounce charge is a non-GST recovery for now ([CA-11]), credited to
`Cheque Bounce Charges` under Indirect Incomes.

## To confirm in the pilot import

These are unconfirmed by Tally's documentation. Each needs one test import, or a voucher keyed in
TallyPrime and exported to XML, which is Tally's own advice.

1. **Cancelled vouchers.** We create the voucher with `ISCANCELLED` Yes and no ledger lines, keeping
   its number (§2.4). The documented route is a second import with `ACTION="Cancel"`.
2. **A note's original invoice.** We write `REFERENCE` / `REFERENCEDATE`. The GST "Original invoice
   no. / date" fields may use other tags.
3. **HSN.** In accounting-voucher mode, HSN is not written per line; it goes in the `.xlsx` and is
   set on the sales ledger's GST details in Tally. The per-entry tag nesting is undocumented.
4. **`GSTDUTYHEAD` values.** We write `CGST`, `SGST/UTGST`, `IGST`, `Cess`, as TallyPrime 7 exports
   them. Older releases show Central / State / Integrated Tax.
5. **Party GST on masters.** We write the flat tags (`PARTYGSTIN`, `LEDSTATENAME`,
   `GSTREGISTRATIONTYPE`). Release 3.0 moved these into dated `LEDGSTREGDETAILS`, and the flat
   tags may be ignored.
6. **Bill of supply.** It goes to the `Sales` voucher type by default; a separate voucher type
   (spec: "separate voucher class") is one option override away.
7. **Bounce as a Journal.** Whether the pilot prefers a `Journal` or a `Payment` voucher for a
   dishonoured cheque, and whether their Journal voucher type accepts the bank or `Cheques in
Hand` ledger (some companies restrict cash and bank ledgers in journals). If they deposit cheques
   by a contra entry from `Cheques in Hand` to the bank, the bounce should credit the bank instead:
   map the cheque mode to the bank ledger.
8. **Bounce number.** `<receipt number>/BOUNCE` on a Journal whose numbering is automatic: Tally
   may renumber it unless the Journal type's numbering is Manual (or the number is kept as the
   reference).
9. **Bounce charge.** A non-GST `Cheque Bounce Charges` line under Indirect Incomes until [CA-11]
   is answered; if the CA wants a debit note with GST, the charge moves to a Debit Note.
10. **Refund voucher (Rule 51).** We export it as a `Payment` voucher with no tax rows, like the
    receipt voucher it repays; if the receipt voucher ever carries tax ([CA-10]), the refund must
    reverse it.

## Ledger mapping

Every amount needs a ledger, found by the business's mapping rules (`ledger_mappings`, round 3a)
or else a default (spec §6.1): `Sales GST 18% Local` / `Interstate`, `Sales Exempt Local`,
`Output CGST 9%` (UTGST in a UT without a legislature), `Output IGST 18%`, `Round Off`, the party's
name or `Cash Sales` for walk-ins, and `Cash`, `UPI Clearing`, `Card Clearing`, `Cheques in Hand`
for payment modes, and `Cheque Bounce Charges` for bounce charges. Bank transfers and "other" modes
have no default and must be mapped. Bounce charges map like any other purpose (optionally per store). A rule
matches on rate, nature, supply type, store, payment mode kind or name, or party; the most
specific rule wins. The export refuses, listing every case at once, when a ledger is unmapped,
blank, or one name stands for two different things (two parties, CGST and SGST, two groups).
Discounts are already netted into the taxable value (CGST s.15(3)(a)), so no "Discount Allowed"
line is written.
