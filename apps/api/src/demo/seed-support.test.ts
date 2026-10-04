import { describe, expect, it } from 'vitest';
import { formatCredentials } from './credentials.js';
import { dayOpensAt, indiaDate, type HistoryClock } from './history-clock.js';
import { buildPlan } from './plan.js';
import { Random } from './random.js';
import { CapturingSmsSender, runSeedCommand } from './seed-command.js';
import { must, SeedContext, Timeline } from './seed-context.js';
import type { DemoCredentials } from './seed.js';

const context = () => new SeedContext(buildPlan('small'), new Random(1), {} as never, {} as never);

describe('SeedContext', () => {
  it('names what is missing', () => {
    const seed = context();
    expect(must(0, 'zero')).toBe(0);
    expect(() => must<string>(undefined, 'thing')).toThrow('Demo seed: no thing');
    expect(() => must<string>(null, 'other')).toThrow('Demo seed: no other');
    expect(() => seed.as('nobody')).toThrow('no session for nobody');
    expect(() => seed.memberId('nobody')).toThrow('no member for nobody');
    expect(() => seed.storeId('AMP')).toThrow('no store for AMP');
    expect(() => seed.party('x')).toThrow('no party for x');
  });

  it('tracks stock, low stock and counts', () => {
    const seed = context();
    expect(seed.onHand('AMP', 'v1')).toBe(0);
    seed.move('AMP', 'v1', 2.5);
    seed.move('AMP', 'v1', -0.1);
    expect(seed.onHand('AMP', 'v1')).toBe(2.4);
    expect(seed.isLow('AMP', 'v1')).toBe(false);
    seed.lowStock.set('AMP', new Set(['v1']));
    expect(seed.isLow('AMP', 'v1')).toBe(true);
    seed.count('leads');
    seed.count('leads', 2);
    expect(seed.created.get('leads')).toBe(3);
  });

  it('knows who works where and turns shares of the history into days', () => {
    const seed = context();
    expect(seed.managerOf('KPL')).toBe('managerKpl');
    expect(seed.salesOf('SEC')).toBe('salesSec');
    expect(seed.salesOf('KPL')).toBe('salesAmp');
    expect(seed.daysAgo(1)).toBe(seed.plan.historyDays);
    expect(seed.daysAgo(0)).toBe(1);
    expect(seed.partiesOf('retail')).toEqual([]);
  });
});

describe('Timeline', () => {
  it('plays days oldest first, in the order added, and today without the clock', async () => {
    const played: string[] = [];
    const clocked: number[] = [];
    const clock = {
      day: async (daysAgo: number, work: () => Promise<void>) => {
        clocked.push(daysAgo);
        await work();
      },
    } as unknown as HistoryClock;
    const timeline = new Timeline();
    const add = (daysAgo: number, name: string) => {
      timeline.at(daysAgo, () => {
        played.push(name);
        return Promise.resolve();
      });
    };
    add(1, 'yesterday');
    add(0, 'today');
    add(5, 'first');
    add(5, 'second');
    await timeline.play(clock);
    expect(played).toEqual(['first', 'second', 'yesterday', 'today']);
    expect(clocked).toEqual([5, 1]);
  });
});

describe('history dates', () => {
  it('works in India time', () => {
    const now = new Date('2026-10-03T20:00:00Z'); // 01:30 on 4 October in India
    expect(indiaDate(0, now)).toBe('2026-10-04');
    expect(indiaDate(3, now)).toBe('2026-10-01');
    expect(dayOpensAt(1, now).toISOString()).toBe('2026-10-03T04:30:00.000Z');
    expect(indiaDate(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dayOpensAt(0).getTime()).toBeLessThan(Date.now() + 86_400_000);
  });
});

describe('sign-in sheet', () => {
  it('lists everyone with how they sign in, and the authenticator details', () => {
    const credentials: DemoCredentials = {
      business: 'Sharma Paints & Hardware',
      password: 'Demo@2026',
      people: [
        {
          name: 'Rajesh Sharma',
          role: 'Owner',
          stores: 'All stores',
          phone: '+919000000001',
          email: null,
          signIn: 'password',
        },
        {
          name: 'Ravi Teja',
          role: 'Store Employee',
          stores: 'Ameerpet',
          phone: '+919000000041',
          email: null,
          signIn: 'mobile code',
        },
      ],
      twoFactor: {
        name: 'Vikram Rao',
        phone: '+919000000003',
        secret: 'ABC',
        otpauthUri: 'otpauth://totp/x?secret=ABC',
        recoveryCodes: ['aaaa-bbbb', 'cccc-dddd'],
      },
    };
    const sheet = formatCredentials(credentials, 'http://localhost:5173');
    expect(sheet).toContain('Open http://localhost:5173');
    expect(sheet).toContain('Password for everyone with one: Demo@2026');
    expect(sheet).toMatch(/Rajesh Sharma\s+Owner\s+\+919000000001\s+All stores\s+password/);
    expect(sheet).toMatch(/Ravi Teja\s+Store Employee\s+\+919000000041\s+Ameerpet\s+mobile code/);
    expect(sheet).toContain('[SMS]');
    expect(sheet).toContain('Setup key (same after every reset): ABC');
    expect(sheet).toContain('otpauth://totp/x?secret=ABC');
    expect(sheet).toContain('aaaa-bbbb cccc-dddd');
  });
});

describe('seed command', () => {
  it('reads sign-in codes from the texts it captured', async () => {
    const sms = new CapturingSmsSender();
    await sms.send('+919000000041', '123456 is your sign-in code.');
    expect(sms.codeFor('+919000000041')).toBe('123456');
    expect(() => sms.codeFor('+919000000042')).toThrow('No sign-in code');
  });

  it('explains its usage and refuses bad settings', async () => {
    const lines: string[] = [];
    expect(await runSeedCommand('nonsense', {}, (line) => lines.push(line))).toBe(2);
    expect(await runSeedCommand(undefined, {}, (line) => lines.push(line))).toBe(2);
    expect(lines[0]).toContain('Usage: seed.js <seed|reset|status>');
    const url = 'postgres://paint:paint@localhost:1/paint_demo';
    const secret = 'x'.repeat(32);
    await expect(runSeedCommand('seed', {}, () => undefined)).rejects.toThrow('DATABASE_URL');
    await expect(
      runSeedCommand('seed', { DATABASE_URL: 'postgres://localhost' }, () => undefined),
    ).rejects.toThrow('DATABASE_URL');
    await expect(runSeedCommand('seed', { DATABASE_URL: url }, () => undefined)).rejects.toThrow(
      'AUTH_SECRET',
    );
    await expect(
      runSeedCommand(
        'seed',
        { DATABASE_URL: url, AUTH_SECRET: secret, DEMO_SIZE: 'huge' },
        () => undefined,
      ),
    ).rejects.toThrow('DEMO_SIZE');
    // With the defaults it gets as far as the database, which is not there.
    await expect(
      runSeedCommand('status', { DATABASE_URL: url, AUTH_SECRET: secret }, () => undefined),
    ).rejects.toThrow();
  });
});
