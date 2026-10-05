import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveFile } from './download.js';
import {
  addDays,
  dateRangeProblems,
  fromIndiaInput,
  indiaDay,
  isDate,
  isIndiaInput,
  toIndiaInput,
  todayInIndia,
} from './india-time.js';

describe('India time', () => {
  it('reads moments as India’s calendar days and wall-clock times', () => {
    // 20:00 UTC is 01:30 the next morning in India.
    expect(indiaDay('2026-10-05T20:00:00.000Z')).toBe('2026-10-06');
    expect(todayInIndia(new Date('2026-10-05T18:29:00.000Z'))).toBe('2026-10-05');
    expect(todayInIndia(new Date('2026-10-05T18:30:00.000Z'))).toBe('2026-10-06');
    expect(toIndiaInput('2026-10-05T05:30:00.000Z')).toBe('2026-10-05T11:00');
    expect(fromIndiaInput('2026-10-05T11:00')).toBe('2026-10-05T11:00:00+05:30');
    expect(Date.parse(fromIndiaInput('2026-10-05T11:00'))).toBe(
      Date.parse('2026-10-05T05:30:00.000Z'),
    );
  });

  it('checks typed dates and times', () => {
    expect(isIndiaInput('2026-10-05T11:00')).toBe(true);
    expect(isIndiaInput('2026-10-05')).toBe(false);
    expect(isIndiaInput('2026-19-05T11:00')).toBe(false);
    expect(isDate('2026-10-05')).toBe(true);
    expect(isDate('2026-02-30')).toBe(false);
    expect(isDate('2026-13-01')).toBe(false);
    expect(isDate('5 Oct')).toBe(false);
  });

  it('moves dates by days across months and years', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('finds problems with a date range', () => {
    expect(dateRangeProblems('', '')).toEqual({});
    expect(dateRangeProblems('2026-10-01', '2026-10-31')).toEqual({});
    expect(dateRangeProblems('2026-10-31', '2026-10-01')).toEqual({ to: 'rangeInvalid' });
    expect(dateRangeProblems('2026-13-01', '2026-10-01')).toEqual({ from: 'dateInvalid' });
    expect(dateRangeProblems('2026-10-01', 'soon')).toEqual({ to: 'dateInvalid' });
    expect(dateRangeProblems('', '2026-10-01')).toEqual({});
    expect(dateRangeProblems('2026-10-01', '')).toEqual({});
  });
});

describe('saveFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('downloads the blob under the given name and frees it', () => {
    const createObjectURL = vi.fn(() => 'blob:file');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const blob = new Blob(['x']);
    saveFile(blob, 'gst.pdf');
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    const [link] = click.mock.contexts as HTMLAnchorElement[];
    expect(link?.download).toBe('gst.pdf');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:file');
  });
});
