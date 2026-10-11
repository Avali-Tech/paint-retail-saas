import type { IssuePaymentRequest, PaymentModeView } from '@paint/shared';

// Taking the money: one or more tenders (cash + UPI…) against the bill's total.

export interface Tender {
  readonly modeId: string;
  readonly amountPaise: number;
}

export interface Settlement {
  /** Everything handed over. */
  readonly tenderedPaise: number;
  /** Still owed after the tenders (0 when covered). */
  readonly shortPaise: number;
  /** Cash to hand back. */
  readonly changePaise: number;
  /** What is recorded: cash net of the change, no empty tenders. */
  readonly payments: IssuePaymentRequest[];
  /** More than the bill by card or UPI, which cannot be handed back as change. */
  readonly overpaid: boolean;
}

/** Settles the tenders against `totalPaise`; change comes out of cash only. */
export function settle(
  totalPaise: number,
  tenders: readonly Tender[],
  modes: readonly PaymentModeView[],
  /** The open register session cash goes into; null leaves it to the server. */
  registerSessionId: string | null,
): Settlement {
  const isCash = (modeId: string) =>
    modes.some((mode) => mode.id === modeId && mode.kind === 'cash');
  const tenderedPaise = tenders.reduce((sum, tender) => sum + tender.amountPaise, 0);
  const over = Math.max(0, tenderedPaise - totalPaise);
  const cashPaise = tenders
    .filter((tender) => isCash(tender.modeId))
    .reduce((sum, tender) => sum + tender.amountPaise, 0);
  const changePaise = Math.min(over, cashPaise);
  // The change comes off the last cash tenders first.
  let toReturn = changePaise;
  const payments = [...tenders]
    .reverse()
    .map((tender) => {
      if (!isCash(tender.modeId)) return tender;
      const back = Math.min(toReturn, tender.amountPaise);
      toReturn -= back;
      // Cash records what was kept and, with change, what was handed over.
      return {
        ...tender,
        amountPaise: tender.amountPaise - back,
        ...(back === 0 ? {} : { tenderedPaise: tender.amountPaise }),
        ...(registerSessionId === null ? {} : { registerSessionId }),
      };
    })
    .reverse()
    .filter((tender) => tender.amountPaise > 0);
  return {
    tenderedPaise,
    shortPaise: Math.max(0, totalPaise - tenderedPaise),
    changePaise,
    payments,
    overpaid: over > cashPaise,
  };
}

/** The mode a new tender starts with: cash first, then UPI, then whatever is left. */
export function nextMode(
  modes: readonly PaymentModeView[],
  used: readonly string[],
): string | null {
  const order = ['cash', 'upi', 'card'];
  const ranked = [...modes].sort(
    (a, b) =>
      ((order.indexOf(a.kind) + 4) % 4) - ((order.indexOf(b.kind) + 4) % 4) ||
      a.name.localeCompare(b.name),
  );
  return (ranked.find((mode) => !used.includes(mode.id)) ?? ranked[0])?.id ?? null;
}
