# Tally export (P2-M07): format notes

The pure mapper in `packages/shared/src/tally/` (round 2c, spec §6.1) turns a period's tax documents
and receipts into TallyPrime import XML and an `.xlsx`. This page records the format choices and
where each comes from, so the pilot accountant's import (the round 2 demo) can confirm or correct
them. Spec §6.1 says the exact tag set is fixed against the pilot's TallyPrime release.

## Files

| File                                | What it is                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `tally-sample-ledgers.xml`          | Ledger masters for the sample month. **Import this first** (`All Masters`)     |
| `tally-sample.xml`                  | The sample month's 59 vouchers (`Vouchers`): 40 invoices, 4 notes, 15 receipts |
| `.../tally/fixtures/*.xml`, `.xlsx` | The same files as golden fixtures; tests compare them byte for byte            |

The sample is "Sharma Paints & Hardware", September 2026: Ameerpet (`AMP`) and Kukatpally (`KKP`)
stores on one Telangana GSTIN, local contractors, walk-ins, and an Andhra Pradesh builder and home
owner billed IGST. It has an exempt line, one cancelled invoice, 3 credit notes, 1 debit note, and
receipts in cash, UPI, cheque and NEFT, one of them an advance. To try it, create a company named
`Sharma Paints & Hardware` with GST enabled (Telangana), then use Import → Masters, then Import →
Transactions.

## Choices and sources

| Topic            | What we write                                                                                                                                                                                                                                                                                                            | Source                                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Envelope         | `HEADER/TALLYREQUEST` "Import Data"; `IMPORTDATA/REQUESTDESC/REPORTNAME` "Vouchers" or "All Masters"; `STATICVARIABLES/SVCURRENTCOMPANY`; `REQUESTDATA/TALLYMESSAGE`                                                                                                                                                     | [Sample XML](https://help.tallysolutions.com/sample-xml/), [XML integration](https://help.tallysolutions.com/xml-integration/)                                                                                                                                     |
| Mode             | Accounting voucher view: `OBJVIEW` and `PERSISTEDVIEW` "Accounting Voucher View", `ISINVOICE` No, ledger lines in `ALLLEDGERENTRIES.LIST`, no stock items (spec §6.1, PO-8)                                                                                                                                              | [Sample XML](https://help.tallysolutions.com/sample-xml/) (voucher-mode sample and Note 2 on accounting invoices)                                                                                                                                                  |
| Debit and credit | Debit: `ISDEEMEDPOSITIVE` Yes and a **negative** `AMOUNT`. Credit: `ISDEEMEDPOSITIVE` No and a positive `AMOUNT`. Bill allocations take their line's sign                                                                                                                                                                | [Sample XML](https://help.tallysolutions.com/sample-xml/): "In sales voucher this should be set to YES for all debiting a ledger"; its sample has party `Yes` / `-21546.00`, sales `No` / `21546.00`                                                               |
| Which side       | Sale and debit note: Dr party = total; Cr sales per rate × supply type; Cr output tax per head and rate; round-off on the side that balances. Credit note: the mirror. Receipt: Dr mode ledger, Cr party                                                                                                                 | Spec §6.1 table                                                                                                                                                                                                                                                    |
| Bills            | Party lines carry `BILLALLOCATIONS.LIST` (`NAME`, `BILLTYPE`, `AMOUNT`). Invoices and debit notes are `New Ref` under their own number. Receipts and credit notes are `Agst Ref` per allocation; the rest is `On Account`, or `Advance` under the receipt voucher number. The walk-in "Cash Sales" ledger keeps no bills | [Sample XML](https://help.tallysolutions.com/sample-xml/) (bill types Advance, Agst Ref, New Ref, On Account)                                                                                                                                                      |
| GST header       | `PARTYNAME`, `GSTREGISTRATIONTYPE` (Regular / Unregistered/Consumer), `PARTYGSTIN`, `STATENAME`, `COUNTRYOFRESIDENCE`, `PLACEOFSUPPLY` (state name), `CMPGSTIN`                                                                                                                                                          | [Schema changes in GST details (Release 3.0)](https://help.tallysolutions.com/what-are-the-changes-in-xml-tags/); registration types: [Tally help](https://help.tallysolutions.com/incorrect-registration-type-or-tax-ledger-is-selected-in-the-bank-transaction/) |
| Identity         | `REMOTEID="paint-<document id>"` on every voucher, so a re-import overwrites instead of duplicating; also `[paint:<document id>]` in the narration (spec §6.1)                                                                                                                                                           | [Import/export FAQ](https://help.tallysolutions.com/docs/faqs/faq/faq-import-and-export.htm)                                                                                                                                                                       |
| Dates, amounts   | `YYYYMMDD`; rupees from integer paise, two decimals, no grouping                                                                                                                                                                                                                                                         | [Sample XML](https://help.tallysolutions.com/sample-xml/): "All dates must follow the YYYYMMDD format"                                                                                                                                                             |
| Escaping         | `&amp; &lt; &gt; &quot; &apos;`; control characters XML 1.0 forbids are dropped. UTF-8                                                                                                                                                                                                                                   | [Special characters FAQ](https://help.tallysolutions.com/article/DeveloperReference/faq/9228.html)                                                                                                                                                                 |
| Ledger masters   | `LEDGER NAME=… ACTION="Create"`, `NAME.LIST`, `PARENT` (a predefined group), `ISBILLWISEON`; parties add GSTIN, registration type, `LEDSTATENAME`; tax ledgers `TAXTYPE` GST, `GSTDUTYHEAD`, `RATEOFTAXCALCULATION`                                                                                                      | [Sample XML](https://help.tallysolutions.com/sample-xml/) (ledger create), [Set up tax ledgers for GST](https://help.tallysolutions.com/set-up-tax-ledgers-for-gst/)                                                                                               |

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

## Ledger mapping

Every amount needs a ledger, found by the business's mapping rules (`ledger_mappings`, round 3a)
or else a default (spec §6.1): `Sales GST 18% Local` / `Interstate`, `Sales Exempt Local`,
`Output CGST 9%` (UTGST in a UT without a legislature), `Output IGST 18%`, `Round Off`, the party's
name or `Cash Sales` for walk-ins, and `Cash`, `UPI Clearing`, `Card Clearing`, `Cheques in Hand`
for payment modes. Bank transfers and "other" modes have no default and must be mapped. A rule
matches on rate, nature, supply type, store, payment mode kind or name, or party; the most
specific rule wins. The export refuses, listing every case at once, when a ledger is unmapped,
blank, or one name stands for two different things (two parties, CGST and SGST, two groups).
Discounts are already netted into the taxable value (CGST s.15(3)(a)), so no "Discount Allowed"
line is written.
