import type { PriceMode, TaxDocumentKind } from '@paint/shared';
import { ApiError } from '../api/errors.js';
import { draftInput, type Bill } from './bill.js';
import type { PosEndpoints } from './pos-api.js';

// Keeps each bill saved as a server draft (spec §5.2: "saved as a draft on every
// change, so a reload or hold loses nothing"). Saves run one at a time, so a quick
// second change waits for the first draft's id instead of creating a second draft.

export interface SavedDraft {
  /** Null when the bill was emptied and its draft discarded. */
  readonly draftId: string | null;
  readonly kind?: TaxDocumentKind;
  readonly priceMode?: PriceMode;
}

export interface DraftSaver {
  save(bill: Bill, storeId: string): Promise<SavedDraft>;
}

export function createDraftSaver(pos: PosEndpoints): DraftSaver {
  /** The draft each bill has on the server, as the saves found it. */
  const drafts = new Map<string, string | null>();
  /** How many drafts each bill has created: an emptied bill's next draft needs a new key. */
  const created = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();

  async function write(bill: Bill, storeId: string): Promise<SavedDraft> {
    const known = drafts.get(bill.key);
    const draftId = known === undefined ? bill.draftId : known;
    if (bill.lines.length === 0) {
      // A draft needs a line: an emptied bill has none on the server.
      if (draftId !== null) {
        await pos.discardDraft(draftId).catch((error: unknown) => {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        });
      }
      drafts.set(bill.key, null);
      return { draftId: null };
    }
    const input = draftInput(bill, storeId);
    let draft;
    if (draftId === null) {
      // A failed create retries with the same key, so a lost answer never makes two drafts.
      const count = created.get(bill.key) ?? 0;
      draft = await pos.createDraft(input, count === 0 ? bill.key : `${bill.key}.${String(count)}`);
      created.set(bill.key, count + 1);
    } else {
      draft = await pos.updateDraft(draftId, input);
    }
    drafts.set(bill.key, draft.id);
    return { draftId: draft.id, kind: draft.kind, priceMode: draft.priceMode };
  }

  return {
    save(bill, storeId) {
      const next = queue.then(() => write(bill, storeId));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
