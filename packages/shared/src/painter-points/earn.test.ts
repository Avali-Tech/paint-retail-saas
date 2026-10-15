import { describe, expect, it } from 'vitest';
import * as shared from '../index.js';
import {
  EARN_BASES,
  MICRO_POINTS,
  assertEarnRule,
  bestRuleFor,
  earnInvoice,
  lineMicroPoints,
  lineMillilitres,
  type EarnLine,
  type EarnRule,
} from './earn.js';

const ASIAN = 'brand-asian';
const BERGER = 'brand-berger';

function rule(overrides: Partial<EarnRule> = {}): EarnRule {
  return {
    id: 'rule-1',
    basis: 'value',
    points: 1,
    per: 10_000,
    brandId: null,
    multiplierBps: 10_000,
    ...overrides,
  };
}

function line(overrides: Partial<EarnLine> = {}): EarnLine {
  return { key: 'line-1', brandId: ASIAN, taxablePaise: 100_000, millilitres: 0, ...overrides };
}

describe('lineMicroPoints', () => {
  it('earns per rupee of taxable value', () => {
    // ₹1,000 at 1 point per ₹100 = 10 points.
    expect(lineMicroPoints(line(), rule())).toBe(10n * BigInt(MICRO_POINTS));
    // ₹1,234.56 at 1 point per ₹100 = 12.3456 points.
    expect(lineMicroPoints(line({ taxablePaise: 123_456 }), rule())).toBe(12_345_600n);
  });

  it('earns per litre of paint', () => {
    const perLitre = rule({ basis: 'litre', points: 2, per: 1000 });
    expect(lineMicroPoints(line({ millilitres: 20_000 }), perLitre)).toBe(40_000_000n);
    expect(lineMicroPoints(line({ millilitres: 900 }), perLitre)).toBe(1_800_000n);
    // Hardware has no litres, so a litre rule gives it nothing.
    expect(lineMicroPoints(line({ millilitres: 0 }), perLitre)).toBe(0n);
  });

  it('applies the multiplier', () => {
    expect(lineMicroPoints(line(), rule({ multiplierBps: 15_000 }))).toBe(15_000_000n);
    expect(lineMicroPoints(line(), rule({ multiplierBps: 5_000 }))).toBe(5_000_000n);
  });

  it('rounds each line down to a millionth of a point', () => {
    // ₹0.01 at 1 point per ₹3 = 0.003333… points.
    expect(lineMicroPoints(line({ taxablePaise: 1 }), rule({ per: 300 }))).toBe(3_333n);
  });

  it('gives nothing to another brand, a zero or a negative line', () => {
    expect(lineMicroPoints(line(), rule({ brandId: BERGER }))).toBe(0n);
    expect(lineMicroPoints(line({ brandId: null }), rule({ brandId: ASIAN }))).toBe(0n);
    expect(lineMicroPoints(line({ taxablePaise: 0 }), rule())).toBe(0n);
    expect(lineMicroPoints(line({ taxablePaise: -500 }), rule())).toBe(0n);
  });

  it('stays exact past 2^53 millionths', () => {
    // ₹10 crore at 5 points per paisa ×3: far beyond a double's whole numbers.
    const micro = lineMicroPoints(
      line({ taxablePaise: 1_000_000_000_00 }),
      rule({ points: 5, per: 1, multiplierBps: 30_000 }),
    );
    expect(micro).toBe(1_000_000_000_00n * 15n * 1_000_000n);
  });

  it('refuses a line that is not whole paise', () => {
    expect(() => lineMicroPoints(line({ taxablePaise: 1.5 }), rule())).toThrow(RangeError);
  });
});

describe('bestRuleFor', () => {
  it('prefers a rule for the line’s brand, even one that earns less', () => {
    const general = rule({ id: 'general', points: 2 });
    const asian = rule({ id: 'asian', brandId: ASIAN });
    expect(bestRuleFor(line(), [general, asian])).toEqual({
      rule: asian,
      microPoints: 10_000_000n,
    });
    expect(bestRuleFor(line({ brandId: BERGER }), [general, asian])?.rule).toBe(general);
  });

  it('falls back to every-brand rules when the brand’s rules earn nothing on the line', () => {
    const general = rule({ id: 'general' });
    const asianLitres = rule({ id: 'asian', brandId: ASIAN, basis: 'litre', per: 1000 });
    expect(bestRuleFor(line({ millilitres: 0 }), [general, asianLitres])?.rule).toBe(general);
  });

  it('takes the rule that earns most, then the lowest id', () => {
    const perRupee = rule({ id: 'b', points: 1 });
    const perLitre = rule({ id: 'a', basis: 'litre', points: 1, per: 1000 });
    // ₹1,000 = 10 points by value; 4 litres = 4 points by volume.
    expect(bestRuleFor(line({ millilitres: 4000 }), [perLitre, perRupee])?.rule).toBe(perRupee);
    // 20 litres = 20 points: volume wins.
    expect(bestRuleFor(line({ millilitres: 20_000 }), [perRupee, perLitre])?.rule).toBe(perLitre);
    // A tie goes to the lowest id, whatever the order.
    const twin = rule({ id: 'c' });
    expect(bestRuleFor(line(), [twin, perRupee])?.rule).toBe(perRupee);
    expect(bestRuleFor(line(), [perRupee, twin])?.rule).toBe(perRupee);
  });

  it('returns null when nothing earns', () => {
    expect(bestRuleFor(line(), [])).toBeNull();
    expect(bestRuleFor(line({ taxablePaise: 0 }), [rule()])).toBeNull();
  });
});

describe('earnInvoice', () => {
  it('sums the lines and rounds down once', () => {
    // Three lines of ₹66.67 at 1 point per ₹100: 0.6667 each, 2.0001 together.
    const lines = ['a', 'b', 'c'].map((key) => line({ key, taxablePaise: 6_667 }));
    const earning = earnInvoice(lines, [rule()]);
    expect(earning.points).toBe(2);
    expect(earning.lines).toEqual(
      lines.map((l) => ({ key: l.key, ruleId: 'rule-1', microPoints: 666_700n })),
    );
  });

  it('marks lines no rule covers', () => {
    const earning = earnInvoice(
      [line({ key: 'paint' }), line({ key: 'brush', brandId: BERGER })],
      [rule({ brandId: ASIAN })],
    );
    expect(earning).toEqual({
      points: 10,
      lines: [
        { key: 'paint', ruleId: 'rule-1', microPoints: 10_000_000n },
        { key: 'brush', ruleId: null, microPoints: 0n },
      ],
    });
  });

  it('earns nothing without rules or lines', () => {
    expect(earnInvoice([line()], [])).toEqual({
      points: 0,
      lines: [{ key: 'line-1', ruleId: null, microPoints: 0n }],
    });
    expect(earnInvoice([], [rule()])).toEqual({ points: 0, lines: [] });
  });

  it('refuses a rule that is not whole and positive', () => {
    expect(() => earnInvoice([line()], [rule({ per: 0 })])).toThrow(/per must be/);
    expect(() => earnInvoice([line()], [rule({ points: 1.5 })])).toThrow(/points must be/);
    expect(() => earnInvoice([line()], [rule({ multiplierBps: -1 })])).toThrow(/multiplierBps/);
  });
});

describe('assertEarnRule', () => {
  it('accepts a well-formed rule', () => {
    expect(() => {
      assertEarnRule(rule());
    }).not.toThrow();
  });
});

describe('lineMillilitres', () => {
  it('converts litre and millilitre packs', () => {
    expect(lineMillilitres(3, 20, 'l')).toBe(60_000);
    expect(lineMillilitres(2, 0.9, 'l')).toBe(1_800);
    expect(lineMillilitres(1.5, 4, 'l')).toBe(6_000);
    expect(lineMillilitres(4, 200, 'ml')).toBe(800);
    expect(lineMillilitres(0.333, 1, 'l')).toBe(333);
  });

  it('rounds to the nearest millilitre', () => {
    // 0.0005 ml rounds to nothing; 1.5 ml rounds half up to 2.
    expect(lineMillilitres(0.001, 0.5, 'ml')).toBe(0);
    expect(lineMillilitres(0.001, 1.5, 'l')).toBe(2);
  });

  it('counts no litres for weights, pieces, or nothing sold', () => {
    expect(lineMillilitres(2, 1, 'kg')).toBe(0);
    expect(lineMillilitres(5, 1, 'piece')).toBe(0);
    expect(lineMillilitres(0, 20, 'l')).toBe(0);
    expect(lineMillilitres(-1, 20, 'l')).toBe(0);
  });
});

describe('painter points exports', () => {
  it('are reachable from the package', () => {
    expect(shared.EARN_BASES).toBe(EARN_BASES);
    expect(EARN_BASES).toEqual(['value', 'litre']);
    expect(typeof shared.earnInvoice).toBe('function');
    expect(typeof shared.reversalTarget).toBe('function');
  });
});
