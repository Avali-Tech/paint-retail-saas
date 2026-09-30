import { withPgClient } from '@paint/testing';
import { describe, expect, inject, it } from 'vitest';
import { formatINR, rupeesToPaise, sumPaise } from './index.js';

// Paise are stored in PostgreSQL as BIGINT. These tests prove the database and
// our helpers agree to the paisa, which is what invoices and ledgers rely on.
describe('money stored in PostgreSQL', () => {
  it('sums paise in the database exactly as sumPaise does', async () => {
    const amounts = ['8,50,000', '0.10', '0.20', '-1250.75', '99999.99'].map(rupeesToPaise);

    const databaseTotal = await withPgClient(inject('databaseUrl'), async (client) => {
      await client.query('CREATE TEMP TABLE ledger (amount_paise BIGINT NOT NULL)');
      for (const amount of amounts) {
        await client.query('INSERT INTO ledger (amount_paise) VALUES ($1)', [amount]);
      }
      const result = await client.query<{ total: string }>(
        'SELECT SUM(amount_paise)::text AS total FROM ledger',
      );
      return Number(result.rows[0]?.total);
    });

    expect(databaseTotal).toBe(sumPaise(amounts));
    expect(formatINR(databaseTotal)).toBe('₹9,48,749.54');
  });

  it('round-trips the largest safe amount without losing a paisa', async () => {
    const stored = await withPgClient(inject('databaseUrl'), async (client) => {
      const result = await client.query<{ amount: string }>('SELECT $1::bigint::text AS amount', [
        Number.MAX_SAFE_INTEGER,
      ]);
      return Number(result.rows[0]?.amount);
    });

    expect(stored).toBe(Number.MAX_SAFE_INTEGER);
  });
});
