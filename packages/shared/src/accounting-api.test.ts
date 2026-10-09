import { describe, expect, it } from 'vitest';
import {
  LEDGER_MATCH_FIELDS,
  TALLY_GROUPS,
  TALLY_LEDGER_PURPOSES,
  accountingExportFile,
  buildTallyExport,
  tallyLedgersXml,
  tallyVouchersXml,
  tallyWorkbook,
} from './index.js';
import { OPTIONS, invoice, period } from './tally/test-support/builders.js';

const data = buildTallyExport(period({ documents: [invoice()] }), OPTIONS);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('accountingExportFile', () => {
  it('packs the Tally XML as a zip: masters to import first, then the vouchers', () => {
    const file = accountingExportFile(data, 'tally_xml');
    expect(file.fileName).toBe(`tally-${data.from}-to-${data.to}.zip`);
    expect(file.contentType).toBe('application/zip');
    const archive = text(file.bytes);
    expect(archive.startsWith('PK')).toBe(true);
    // Stored, not compressed: both files are readable inside, masters first.
    const masters = archive.indexOf('1-masters.xml');
    const vouchers = archive.indexOf('2-vouchers.xml');
    expect(masters).toBeGreaterThan(-1);
    expect(vouchers).toBeGreaterThan(masters);
    expect(archive).toContain(tallyLedgersXml(data, []));
    expect(archive).toContain(tallyVouchersXml(data));
  });

  it('gives the workbook as .xlsx', () => {
    const file = accountingExportFile(data, 'xlsx');
    expect(file.fileName).toBe(`tally-${data.from}-to-${data.to}.xlsx`);
    expect(file.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(file.bytes).toEqual(tallyWorkbook(data));
  });
});

describe('ledger mapping settings', () => {
  it('lets every purpose match per store, and only on facts its amounts carry', () => {
    expect(Object.keys(LEDGER_MATCH_FIELDS)).toEqual([...TALLY_LEDGER_PURPOSES]);
    for (const purpose of TALLY_LEDGER_PURPOSES) {
      expect(LEDGER_MATCH_FIELDS[purpose]).toContain('storeId');
    }
    expect(LEDGER_MATCH_FIELDS.party).toEqual(['partyId', 'storeId']);
    expect(LEDGER_MATCH_FIELDS.payment_mode).toEqual(['modeKind', 'modeId', 'storeId']);
    expect(TALLY_GROUPS).toContain('Duties & Taxes');
  });
});
