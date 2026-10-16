import { schema, type Transaction } from '@paint/db';
import {
  DEFAULT_COST_OF_MONEY_BPS,
  DEFAULT_POINT_VALUE_PAISE,
  type ProfitabilitySettings,
  type ProfitabilitySettingsInput,
} from '@paint/shared';
import { sql } from 'drizzle-orm';

const { loyaltySettings, salesSettings } = schema;

/**
 * The business's cost of money (`sales_settings.cost_of_money_bps`, [PO-5]) and
 * point value (`loyalty_settings.point_value_paise`), with the column defaults for a
 * business that has no settings row yet. Reads the tenant's own rows (RLS).
 */
export async function profitabilitySettings(tx: Transaction): Promise<ProfitabilitySettings> {
  const [sales] = await tx
    .select({ costOfMoneyBps: salesSettings.costOfMoneyBps })
    .from(salesSettings);
  const [loyalty] = await tx
    .select({ pointValuePaise: loyaltySettings.pointValuePaise })
    .from(loyaltySettings);
  return {
    costOfMoneyBps: sales?.costOfMoneyBps ?? DEFAULT_COST_OF_MONEY_BPS,
    pointValuePaise: loyalty?.pointValuePaise ?? DEFAULT_POINT_VALUE_PAISE,
  };
}

/** Saves either or both settings (each row created when missing; both audited). */
export async function saveProfitabilitySettings(
  tx: Transaction,
  organizationId: string,
  input: ProfitabilitySettingsInput,
): Promise<ProfitabilitySettings> {
  if (input.costOfMoneyBps !== undefined) {
    const set = { costOfMoneyBps: input.costOfMoneyBps };
    await tx
      .insert(salesSettings)
      .values({ organizationId, ...set })
      .onConflictDoUpdate({
        target: salesSettings.organizationId,
        set: { ...set, updatedAt: sql`now()` },
      });
  }
  if (input.pointValuePaise !== undefined) {
    const set = { pointValuePaise: input.pointValuePaise };
    await tx
      .insert(loyaltySettings)
      .values({ organizationId, ...set })
      .onConflictDoUpdate({
        target: loyaltySettings.organizationId,
        set: { ...set, updatedAt: sql`now()` },
      });
  }
  return profitabilitySettings(tx);
}
