import { describe, expect, it } from 'vitest';
import { createI18n } from '../i18n/i18n.js';
import { CONTRACT, DRAFT } from '../test-support/contract-fixtures.js';
import {
  contractSchema,
  contractValues,
  toContractChange,
  toNewContract,
  type ContractValues,
} from './contract-form.js';
import { renewalDays } from './ContractsPage.js';

const schema = contractSchema(createI18n('en').t);
const VALID: ContractValues = {
  ...contractValues(null),
  title: 'Annual painting contract',
  startDate: '2026-11-01',
  endDate: '2027-10-31',
};
const issues = (values: Partial<ContractValues>) =>
  schema
    .safeParse({ ...VALID, ...values })
    .error?.issues.map((issue) => [issue.path.join('.'), issue.message]);

describe('contract form', () => {
  it('starts empty, or with the contract being edited in rupees', () => {
    expect(contractValues(null)).toMatchObject({
      type: 'contractor_agreement',
      storeId: '',
      value: '',
      assignedMemberId: '',
    });
    expect(contractValues(CONTRACT)).toMatchObject({
      storeId: 'store-hyd',
      value: '1000000.00',
      renewalDate: '2026-10-01',
      assignedMemberId: 'member-1',
      creditTerms: '',
    });
    expect(contractValues(DRAFT)).toMatchObject({ storeId: '', value: '' });
  });

  it('checks dates, the title and the value like the API', () => {
    expect(issues({})).toBeUndefined();
    expect(issues({ title: ' ', startDate: '', value: '-5' })).toEqual([
      ['title', 'Enter a title'],
      ['startDate', 'Enter a date'],
      ['value', 'Enter an amount in rupees, e.g. 250000 or 2,50,000.50'],
    ]);
    expect(issues({ value: 'lots' })).toEqual([
      ['value', 'Enter an amount in rupees, e.g. 250000 or 2,50,000.50'],
    ]);
    expect(issues({ endDate: '2026-10-31' })).toEqual([
      ['endDate', 'The end date cannot be before the start date'],
    ]);
    expect(issues({ renewalDate: '2027-11-01' })).toEqual([
      ['renewalDate', 'The renewal date cannot be after the end date'],
    ]);
    expect(issues({ renewalDate: 'soon' })?.[0]).toEqual(['renewalDate', 'Enter a date']);
  });

  it('creates with only what was filled in, money in paise', () => {
    expect(toNewContract(VALID, 'p1')).toEqual({
      type: 'contractor_agreement',
      title: 'Annual painting contract',
      partyId: 'p1',
      startDate: '2026-11-01',
      endDate: '2027-10-31',
    });
    expect(
      toNewContract(
        {
          ...VALID,
          storeId: 's1',
          renewalDate: '2027-09-01',
          value: '2,50,000.50',
          terms: ' 12% below MRP ',
          creditTerms: '30 days',
          discountTerms: '5%',
          notes: 'VIP',
          assignedMemberId: 'm2',
        },
        'p1',
      ),
    ).toMatchObject({
      storeId: 's1',
      renewalDate: '2027-09-01',
      valuePaise: 2_50_000_50,
      terms: '12% below MRP',
      creditTerms: '30 days',
      discountTerms: '5%',
      notes: 'VIP',
      assignedMemberId: 'm2',
    });
  });

  it('edits every field, clearing emptied ones and resetting an emptied renewal date', () => {
    expect(toContractChange({ ...contractValues(CONTRACT), renewalDate: '', value: '' })).toEqual({
      type: 'contractor_agreement',
      title: 'Annual painting contract',
      startDate: '2025-11-01',
      endDate: '2026-10-31',
      valuePaise: null,
      terms: 'Paint supplied at 12% below MRP.\nDelivery within 3 days.',
      creditTerms: null,
      discountTerms: null,
      notes: null,
      assignedMemberId: 'member-1',
    });
    expect(toContractChange({ ...VALID, renewalDate: '2027-10-01' })).toMatchObject({
      renewalDate: '2027-10-01',
    });
    expect(toContractChange(VALID)).not.toHaveProperty('assignedMemberId');
  });

  it('reads the renewal window in days', () => {
    expect(renewalDays('30')).toBe(30);
    expect(renewalDays(' 0 ')).toBe(0);
    expect(renewalDays('366')).toBe(366);
    expect(renewalDays('367')).toBeNull();
    expect(renewalDays('a month')).toBeNull();
  });
});
