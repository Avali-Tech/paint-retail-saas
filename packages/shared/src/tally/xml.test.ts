import { describe, expect, it } from 'vitest';
import { buildTallyExport, tallyLedgersXml, tallyVouchersXml } from '../index.js';
import {
  BUYER,
  LINE,
  OPTIONS,
  WALK_IN,
  invoice,
  period,
  receipt,
} from './test-support/builders.js';
import { escapeXml, remoteId, tallyAmount, tallyDate } from './xml.js';

describe('XML primitives', () => {
  it('escapes markup and drops characters XML 1.0 cannot hold', () => {
    expect(escapeXml(`Reddy & Sons <"Contractors"> 'HYD'`)).toBe(
      'Reddy &amp; Sons &lt;&quot;Contractors&quot;&gt; &apos;HYD&apos;',
    );
    expect(escapeXml('a\u0000b\u0007c\td\ne\u001ff￿')).toBe('abc\td\nef');
  });

  it('writes dates as YYYYMMDD and amounts signed by Tally’s convention', () => {
    expect(tallyDate('2026-09-05')).toBe('20260905');
    expect(tallyAmount('debit', 118000)).toBe('-1180.00');
    expect(tallyAmount('credit', 5)).toBe('0.05');
    expect(remoteId('d1')).toBe('paint-d1');
  });
});

describe('tallyVouchersXml', () => {
  it('writes one voucher with its GST header, signed entries and bills', () => {
    const data = buildTallyExport(period(), OPTIONS);
    expect(tallyVouchersXml(data)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>Vouchers</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>Sharma Paints &amp; Hardware</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER REMOTEID="paint-d1" VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">
      <DATE>20260910</DATE>
      <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
      <VOUCHERNUMBER>AMP/26-27/000001</VOUCHERNUMBER>
      <PARTYLEDGERNAME>Sri Sai Constructions</PARTYLEDGERNAME>
      <PARTYNAME>Sri Sai Constructions</PARTYNAME>
      <GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>
      <PARTYGSTIN>${String(BUYER.gstin)}</PARTYGSTIN>
      <STATENAME>Telangana</STATENAME>
      <COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>
      <PLACEOFSUPPLY>Telangana</PLACEOFSUPPLY>
      <CMPGSTIN>${invoice().supplierGstin}</CMPGSTIN>
      <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
      <ISINVOICE>No</ISINVOICE>
      <ISCANCELLED>No</ISCANCELLED>
      <NARRATION>Tax invoice AMP/26-27/000001; [paint:d1]</NARRATION>
      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>Sri Sai Constructions</LEDGERNAME>
       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
       <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
       <AMOUNT>-1180.00</AMOUNT>
       <BILLALLOCATIONS.LIST>
        <NAME>AMP/26-27/000001</NAME>
        <BILLTYPE>New Ref</BILLTYPE>
        <AMOUNT>-1180.00</AMOUNT>
       </BILLALLOCATIONS.LIST>
      </ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>Sales GST 18% Local</LEDGERNAME>
       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
       <ISPARTYLEDGER>No</ISPARTYLEDGER>
       <AMOUNT>1000.00</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>Output CGST 9%</LEDGERNAME>
       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
       <ISPARTYLEDGER>No</ISPARTYLEDGER>
       <AMOUNT>90.00</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>Output SGST 9%</LEDGERNAME>
       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
       <ISPARTYLEDGER>No</ISPARTYLEDGER>
       <AMOUNT>90.00</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
     </VOUCHER>
    </TALLYMESSAGE>
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>
`);
  });

  it('names the original invoice on a note and the delivery state for a walk-in', () => {
    const note = invoice({
      kind: 'credit_note',
      party: WALK_IN,
      placeOfSupplyCode: '37',
      supplyType: 'inter_state',
      lines: [{ ...LINE, cgstPaise: 0, sgstPaise: 0, igstPaise: 18000 }],
      originals: [{ number: 'AMP/26-27/000009', issuedOn: '2026-09-02' }],
    });
    const xml = tallyVouchersXml(buildTallyExport(period({ documents: [note] }), OPTIONS));
    expect(xml).toContain(
      '<REFERENCE>AMP/26-27/000009</REFERENCE>\n      <REFERENCEDATE>20260902</REFERENCEDATE>',
    );
    expect(xml).toContain(
      '<GSTREGISTRATIONTYPE>Unregistered/Consumer</GSTREGISTRATIONTYPE>\n      <STATENAME>Andhra Pradesh</STATENAME>',
    );
    expect(xml).not.toContain('<PARTYGSTIN>');
  });

  it('writes a receipt without a GST header', () => {
    const xml = tallyVouchersXml(
      buildTallyExport(period({ documents: [], receipts: [receipt()] }), OPTIONS),
    );
    expect(xml).toContain(
      '<PARTYLEDGERNAME>Sri Sai Constructions</PARTYLEDGERNAME>\n      <PERSISTEDVIEW>',
    );
    expect(xml).toContain(
      '<LEDGERNAME>Cash</LEDGERNAME>\n       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n       <ISPARTYLEDGER>No</ISPARTYLEDGER>\n       <AMOUNT>-1180.00</AMOUNT>',
    );
  });
});

describe('tallyLedgersXml', () => {
  const unregistered = { ...BUYER, id: 'b2', name: 'Ravi <Painter>', gstin: null, stateCode: null };
  const data = buildTallyExport(
    period({
      documents: [
        invoice(),
        invoice({ id: 'd2', number: 'AMP/26-27/000002', party: unregistered }),
      ],
    }),
    OPTIONS,
  );

  it('creates parties with GST details, and duty ledgers with head and rate', () => {
    const xml = tallyLedgersXml(data, []);
    expect(xml).toContain(`     <LEDGER NAME="Sri Sai Constructions" ACTION="Create">
      <NAME.LIST>
       <NAME>Sri Sai Constructions</NAME>
      </NAME.LIST>
      <PARENT>Sundry Debtors</PARENT>
      <ISBILLWISEON>Yes</ISBILLWISEON>
      <AFFECTSSTOCK>No</AFFECTSSTOCK>
      <GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>
      <PARTYGSTIN>${String(BUYER.gstin)}</PARTYGSTIN>
      <LEDSTATENAME>Telangana</LEDSTATENAME>
      <COUNTRYNAME>India</COUNTRYNAME>
     </LEDGER>`);
    expect(xml).toContain(`     <LEDGER NAME="Ravi &lt;Painter&gt;" ACTION="Create">
      <NAME.LIST>
       <NAME>Ravi &lt;Painter&gt;</NAME>
      </NAME.LIST>
      <PARENT>Sundry Debtors</PARENT>
      <ISBILLWISEON>Yes</ISBILLWISEON>
      <AFFECTSSTOCK>No</AFFECTSSTOCK>
      <GSTREGISTRATIONTYPE>Unregistered/Consumer</GSTREGISTRATIONTYPE>
      <COUNTRYNAME>India</COUNTRYNAME>
     </LEDGER>`);
    expect(xml).toContain(`      <PARENT>Duties &amp; Taxes</PARENT>
      <ISBILLWISEON>No</ISBILLWISEON>
      <AFFECTSSTOCK>No</AFFECTSSTOCK>
      <TAXTYPE>GST</TAXTYPE>
      <GSTDUTYHEAD>SGST/UTGST</GSTDUTYHEAD>
      <RATEOFTAXCALCULATION>9.00</RATEOFTAXCALCULATION>`);
    expect(xml).toContain(
      '<PARENT>Sales Accounts</PARENT>\n      <ISBILLWISEON>No</ISBILLWISEON>\n      <AFFECTSSTOCK>No</AFFECTSSTOCK>\n     </LEDGER>',
    );
  });

  it('leaves out ledgers the company already has, matching names without case', () => {
    const xml = tallyLedgersXml(data, ['sales gst 18% local', 'OUTPUT CGST 9%', 'Output SGST 9%']);
    expect([...xml.matchAll(/<LEDGER NAME="([^"]*)"/g)].map((m) => m[1])).toEqual([
      'Ravi &lt;Painter&gt;',
      'Sri Sai Constructions',
    ]);
    expect(
      tallyLedgersXml(
        data,
        data.ledgers.map((l) => l.name),
      ),
    ).toContain('   <REQUESTDATA>\n   </REQUESTDATA>');
  });
});
