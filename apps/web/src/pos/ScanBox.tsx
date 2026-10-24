import { Button, Field, Input, Spinner } from '@paint/ui';
import { useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { Product, Variant } from '../api/catalog.js';
import { ApiError, errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { variantTitle } from '../lib/product-title.js';
import { isTintableProduct } from '../tint/tint.js';
import type { BillItem } from './bill.js';
import { parseScan } from './entry.js';

/** Keys the scan box hands to the bill when nothing is typed in it. */
export type LineKey = 'more' | 'less' | 'remove' | 'up' | 'down';

interface Match {
  readonly product: Product;
  readonly variant: Variant;
}

/** A pack as the bill holds it, at `price`. */
export const itemOf = ({ product, variant }: Match, price: number): BillItem => ({
  variantId: variant.id,
  sku: variant.sku,
  name: variantTitle(product.brand.name, product.name, variant),
  taxCategoryId: product.taxCategory?.id ?? null,
  unitPricePaise: price,
  tintable: isTintableProduct(product),
});

const LINE_KEYS: Readonly<Record<string, LineKey>> = {
  '+': 'more',
  '-': 'less',
  Delete: 'remove',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

/**
 * The one box at the counter (spec §5.2): a scanner types the barcode and presses
 * Enter; a person types an SKU, 2–3 letters of a name or a size label and presses
 * Enter. "3*" first sets the quantity. One match is added at once; several are
 * offered, picked with the arrow keys and Enter.
 */
export function ScanBox({
  inputRef,
  onAdd,
  onLineKey,
  onQuantity,
}: {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onAdd: (item: BillItem, quantity: number) => void;
  readonly onLineKey: (key: LineKey) => void;
  /** "5*" with no code: the quantity of the line the keys act on. */
  readonly onQuantity: (quantity: number) => void;
}) {
  const api = useApi();
  const { t, money } = useI18n();
  const listId = useId();
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [matches, setMatches] = useState<{ quantity: number; options: Match[] } | null>(null);
  const [active, setActive] = useState(0);
  const [inFlight, setInFlight] = useState(0);
  // Lookups run one after another, so lines land in the order they were scanned.
  const queue = useRef<Promise<void>>(Promise.resolve());
  // Bumped by every edit and submit: a scan gives its code back only if nothing came since.
  const edits = useRef(0);

  /** Adds a match; false (with the reason shown) when it cannot be sold. */
  const add = ({ product, variant }: Match, quantity: number): boolean => {
    if (!(product.isActive && variant.isActive)) {
      setMessage(t('pos.scan.inactive', { sku: variant.sku }));
      return false;
    }
    if (variant.sellingPricePaise === null) {
      setMessage(t('pos.scan.noPrice', { sku: variant.sku }));
      return false;
    }
    onAdd(itemOf({ product, variant }, variant.sellingPricePaise), quantity);
    return true;
  };

  const choose = (match: Match, quantity: number) => {
    if (!add(match, quantity)) return;
    setText('');
    setMatches(null);
    setMessage(null);
  };

  /** A barcode or SKU exactly; null when none matches (then the name search runs). */
  const exact = async (code: string): Promise<Match | null> => {
    if (/\s/.test(code)) return null;
    try {
      return await api.catalog.lookup(code, true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  };

  const lookup = async (scanned: string, code: string, quantity: number, edit: number) => {
    const giveBack = () => {
      if (edits.current === edit) setText(scanned);
    };
    try {
      const found = await exact(code);
      if (found !== null) {
        add(found, quantity);
        return;
      }
      const page = await api.catalog.products({ q: code, limit: 10 });
      const candidates = page.items.flatMap((product) =>
        product.isActive
          ? product.variants
              .filter((variant) => variant.isActive)
              .map((variant) => ({ product, variant }))
          : [],
      );
      const [only] = candidates;
      if (only !== undefined && candidates.length === 1) add(only, quantity);
      else if (only === undefined) {
        setMessage(t('pos.scan.notFound', { code }));
        giveBack();
      } else {
        setMatches({ quantity, options: candidates });
        setActive(0);
        giveBack();
      }
    } catch (error) {
      setMessage(errorMessage(error));
      giveBack();
    } finally {
      setInFlight((count) => count - 1);
    }
  };

  /** Takes the text and empties the box at once, so the next scan can be typed meanwhile. */
  const find = () => {
    const scanned = text;
    const { quantity, code } = parseScan(scanned);
    setText('');
    if (code === '') {
      if (scanned.trim() !== '') onQuantity(quantity);
      return;
    }
    edits.current += 1;
    const edit = edits.current;
    setInFlight((count) => count + 1);
    setMessage(null);
    setMatches(null);
    queue.current = queue.current.then(() => lookup(scanned, code, quantity, edit));
  };

  const { quantity: pending, options } = matches ?? { quantity: 1, options: [] };
  const optionId = (index: number) => `${listId}-${String(index)}`;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setMatches(null);
      setMessage(null);
      return;
    }
    if (matches !== null && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((active + step + options.length) % options.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = options[active];
      if (chosen !== undefined) choose(chosen, pending);
      else find();
      return;
    }
    const lineKey = LINE_KEYS[event.key];
    if (lineKey !== undefined && text === '') {
      event.preventDefault();
      onLineKey(lineKey);
    }
  };

  return (
    <div className="pos-scan">
      <div className="pos-scan__row">
        <Field label={t('pos.scan.label')} hint={t('pos.scan.hint')} error={message ?? undefined}>
          <Input
            ref={inputRef}
            className="pos-scan__input"
            type="search"
            role="combobox"
            aria-expanded={matches !== null}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={matches === null ? undefined : optionId(active)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            // The screen opens ready for the scanner (spec §5.2 step 1).
            autoFocus
            value={text}
            onChange={(event) => {
              edits.current += 1;
              setText(event.target.value);
              setMessage(null);
            }}
            onKeyDown={onKeyDown}
          />
        </Field>
        <Button
          variant="secondary"
          loading={inFlight > 0}
          onClick={() => {
            find();
            inputRef.current?.focus();
          }}
        >
          {t('pos.scan.find')}
        </Button>
      </div>
      {inFlight > 0 && <Spinner size="sm" label={t('common.loading')} />}
      <ul
        id={listId}
        role="listbox"
        aria-label={t('pos.scan.results')}
        className="pos-scan__results"
        hidden={matches === null}
      >
        {options.map((option, index) => (
          <li
            key={option.variant.id}
            id={optionId(index)}
            role="option"
            aria-selected={index === active}
            className="pos-scan__option"
            onMouseDown={(event) => {
              // Keep the focus in the box, where the next scan is typed.
              event.preventDefault();
              choose(option, pending);
            }}
          >
            {t('pos.scan.option', {
              name: variantTitle(option.product.brand.name, option.product.name, option.variant),
              sku: option.variant.sku,
              price:
                option.variant.sellingPricePaise === null
                  ? '—'
                  : money(option.variant.sellingPricePaise),
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}
