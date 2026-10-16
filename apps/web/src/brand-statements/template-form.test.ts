import { describe, expect, it } from 'vitest';
import { SIGNED_TEMPLATE, TEMPLATE } from '../test-support/statement-fixtures.js';
import { NEW_TEMPLATE, readTemplate, templateValues } from './template-form.js';

const filled = { ...NEW_TEMPLATE, name: ' Deccan ledger ', supplierPartyId: 'sup-deccan' };

describe('readTemplate', () => {
  it('needs a name, a supplier and the columns of its amount mode', () => {
    expect(readTemplate(NEW_TEMPLATE)).toEqual({
      ok: false,
      problems: { name: 'required', supplierPartyId: 'required' },
    });
    expect(
      readTemplate({
        ...filled,
        dateColumn: ' ',
        documentColumn: '',
        debitColumn: '',
        creditColumn: '',
      }),
    ).toEqual({
      ok: false,
      problems: {
        dateColumn: 'required',
        documentColumn: 'required',
        debitColumn: 'required',
        creditColumn: 'required',
      },
    });
    expect(readTemplate({ ...filled, amountMode: 'signed', amountColumn: '' })).toEqual({
      ok: false,
      problems: { amountColumn: 'required' },
    });
  });

  it('keeps the rows to skip, the date window and the tolerance in range', () => {
    expect(
      readTemplate({
        ...filled,
        headerRowsToSkip: '51',
        dateWindowDays: 'x',
        tolerance: '1000.01',
      }),
    ).toEqual({
      ok: false,
      problems: { headerRowsToSkip: 'range', dateWindowDays: 'range', tolerance: 'range' },
    });
    expect(readTemplate({ ...filled, dateWindowDays: '61', tolerance: '-1' })).toEqual({
      ok: false,
      problems: { dateWindowDays: 'range', tolerance: 'range' },
    });
    expect(readTemplate({ ...filled, tolerance: 'abc' })).toMatchObject({ ok: false });
  });

  it('reads the template as the API takes it, leaving out kinds with no words', () => {
    expect(readTemplate({ ...filled, words: { ...filled.words, debit_note: ' , ' } })).toEqual({
      ok: true,
      input: {
        name: 'Deccan ledger',
        supplierPartyId: 'sup-deccan',
        brandId: null,
        headerRowsToSkip: 0,
        dateColumn: 'Date',
        documentColumn: 'Document No',
        typeColumn: 'Type',
        referenceColumn: null,
        descriptionColumn: 'Narration',
        amountMode: 'debit_credit',
        debitColumn: 'Debit',
        creditColumn: 'Credit',
        amountColumn: null,
        signConvention: 'debit_positive',
        dateFormat: 'dd-mm-yyyy',
        typeRules: {
          opening: ['Opening'],
          invoice: ['Invoice', 'INV'],
          credit_note: ['Credit Note', 'CN'],
          payment: ['Receipt', 'Payment'],
        },
        dateWindowDays: 7,
        amountTolerancePaise: 100,
        grnAmountBasis: 'with_gst',
        isActive: true,
      },
    });
    const signed = readTemplate({
      ...filled,
      brandId: 'brand-apex',
      amountMode: 'signed',
      amountColumn: ' Amount ',
      signConvention: 'credit_positive',
    });
    expect(signed).toMatchObject({
      ok: true,
      input: {
        brandId: 'brand-apex',
        debitColumn: null,
        creditColumn: null,
        amountColumn: 'Amount',
        signConvention: 'credit_positive',
      },
    });
  });
});

describe('templateValues', () => {
  it('shows a saved template as the form types it, and reads back the same', () => {
    const values = templateValues(TEMPLATE);
    expect(values).toMatchObject({
      brandId: 'brand-apex',
      headerRowsToSkip: '1',
      referenceColumn: '',
      amountColumn: '',
      tolerance: '1.00',
      words: { credit_note: 'Credit Note', payment: 'Receipt', invoice: '' },
    });
    const read = readTemplate(values);
    expect(read).toMatchObject({ ok: true, input: { typeRules: TEMPLATE.typeRules } });
    expect(templateValues(SIGNED_TEMPLATE)).toMatchObject({
      brandId: '',
      typeColumn: '',
      descriptionColumn: '',
      debitColumn: '',
      creditColumn: '',
      amountColumn: 'Amount',
      isActive: false,
    });
  });
});
