import { Button, Icon, Input } from '@paint/ui';
import { priceLine } from '@paint/shared';
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { parsePositiveQuantity } from '../lib/quantity.js';
import { TintControl } from '../tint/TintPanel.js';
import type { BillAction, BillLine } from './bill.js';
import { discountText, parseDiscount } from './entry.js';

/** A value typed in a line's box, kept while it is being edited. */
function useEditing() {
  const [text, setText] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  return { text, setText, invalid, setInvalid };
}

/** Enter in a line's box commits it; Escape puts the line's value back. */
const commitKeys =
  (commit: () => void, undo: () => void) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') undo();
  };

function LineRow({
  line,
  index,
  amountPaise,
  selected,
  partyId,
  dispatch,
}: {
  readonly line: BillLine;
  readonly index: number;
  readonly amountPaise: number;
  readonly selected: boolean;
  readonly partyId: string | null;
  readonly dispatch: Dispatch<BillAction>;
}) {
  const { t, money, number } = useI18n();
  // Discounts need billing:discount (the API refuses them too).
  const mayDiscount = usePermissions()('billing:discount');
  const quantity = useEditing();
  const discount = useEditing();
  const name = line.name;

  const commitQuantity = () => {
    if (quantity.text === null) return;
    const value = parsePositiveQuantity(quantity.text);
    quantity.setInvalid(value === null);
    if (value === null) return;
    quantity.setText(null);
    if (value !== line.quantity) dispatch({ type: 'quantity', index, quantity: value });
  };
  const commitDiscount = () => {
    if (discount.text === null) return;
    const parsed = parseDiscount(
      discount.text,
      priceLine({ ...line, categoryCode: '' }).grossPaise,
    );
    discount.setInvalid(parsed === null);
    if (parsed === null) return;
    discount.setText(null);
    dispatch({ type: 'discount', index, discount: parsed.discount });
  };
  let discountTitle: string | undefined;
  if (!mayDiscount) discountTitle = t('pos.lines.noDiscount');
  else if (discount.invalid) discountTitle = t('pos.lines.discountInvalid');

  return (
    <li
      className="pos-line"
      data-selected={selected ? '' : undefined}
      aria-label={name}
      onFocus={() => {
        if (!selected) dispatch({ type: 'select', index });
      }}
    >
      <div className="pos-line__item">
        <span className="pos-line__name">{name}</span>
        <span className="pos-line__meta">
          {line.sku === '' ? '' : `${line.sku} · `}
          {t('pos.lines.perUnit', { price: money(line.unitPricePaise) })}
        </span>
        <TintControl line={line} index={index} partyId={partyId} dispatch={dispatch} />
      </div>
      <div className="pos-line__quantity">
        <Button
          variant="secondary"
          size="sm"
          aria-label={t('pos.lines.less', { name })}
          disabled={line.quantity <= 1}
          onClick={() => {
            dispatch({ type: 'step', index, by: -1 });
          }}
        >
          −
        </Button>
        <Input
          className="pos-line__number"
          inputMode="decimal"
          aria-label={t('pos.lines.quantityOf', { name })}
          aria-invalid={quantity.invalid || undefined}
          title={quantity.invalid ? t('pos.lines.quantityInvalid') : undefined}
          value={quantity.text ?? number(line.quantity)}
          onFocus={() => {
            quantity.setText(String(line.quantity));
          }}
          onChange={(event) => {
            quantity.setText(event.target.value);
          }}
          onBlur={commitQuantity}
          onKeyDown={commitKeys(commitQuantity, () => {
            quantity.setText(null);
            quantity.setInvalid(false);
          })}
        />
        <Button
          variant="secondary"
          size="sm"
          aria-label={t('pos.lines.more', { name })}
          onClick={() => {
            dispatch({ type: 'step', index, by: 1 });
          }}
        >
          +
        </Button>
      </div>
      <Input
        className="pos-line__discount"
        aria-label={t('pos.lines.discountOf', { name })}
        placeholder={mayDiscount ? t('pos.lines.discountHint') : undefined}
        disabled={!mayDiscount}
        aria-invalid={discount.invalid || undefined}
        title={discountTitle}
        value={discount.text ?? discountText(line.discount)}
        onFocus={() => {
          discount.setText(discountText(line.discount));
        }}
        onChange={(event) => {
          discount.setText(event.target.value);
        }}
        onBlur={commitDiscount}
        onKeyDown={commitKeys(commitDiscount, () => {
          discount.setText(null);
          discount.setInvalid(false);
        })}
      />
      <span className="pos-line__amount numeric">{money(amountPaise)}</span>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('pos.lines.remove', { name })}
        data-line-remove=""
        onClick={() => {
          dispatch({ type: 'remove', index });
        }}
      >
        <Icon name="close" size={16} />
      </Button>
      {(quantity.invalid || discount.invalid) && (
        <p className="pos-line__error" role="alert">
          {quantity.invalid ? t('pos.lines.quantityInvalid') : t('pos.lines.discountInvalid')}
        </p>
      )}
    </li>
  );
}

/**
 * The bill's lines: quantity with − / + or typed, a discount as "10%" or rupees, a
 * tint for a tintable base (spec §6.3), remove.
 */
export function BillLines({
  lines,
  amounts,
  selected,
  partyId = null,
  dispatch,
  focusWhenEmpty,
}: {
  readonly lines: readonly BillLine[];
  /** Each line's amount as the preview worked it out. */
  readonly amounts: readonly number[];
  readonly selected: number | null;
  /** The bill-to, whose past shades the tint panel offers. */
  readonly partyId?: string | null;
  readonly dispatch: Dispatch<BillAction>;
  /** Where the focus goes when the last line is removed (the scan box). */
  readonly focusWhenEmpty: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const list = useRef<HTMLOListElement>(null);
  // A line removed with its own button takes that button with it: the focus moves to
  // the line now in its place (or the last one), or to `focusWhenEmpty`, not the page.
  const removed = useRef<number | null>(null);
  useEffect(() => {
    const at = removed.current;
    if (at === null) return;
    removed.current = null;
    const buttons = list.current?.querySelectorAll<HTMLElement>('[data-line-remove]') ?? [];
    (buttons[Math.min(at, buttons.length - 1)] ?? focusWhenEmpty.current)?.focus();
  }, [lines, focusWhenEmpty]);
  const lineDispatch: Dispatch<BillAction> = (action) => {
    if (action.type === 'remove') removed.current = action.index;
    dispatch(action);
  };
  if (lines.length === 0) return <p className="pos-lines__empty muted">{t('pos.lines.empty')}</p>;
  return (
    <>
      {/* Column names for wide screens; each control has its own label. */}
      <div className="pos-lines__head" aria-hidden="true">
        <span>{t('pos.lines.item')}</span>
        <span>{t('pos.lines.quantity')}</span>
        <span>{t('pos.lines.discount')}</span>
        <span className="numeric">{t('pos.lines.amount')}</span>
      </div>
      <ol ref={list} className="pos-lines" aria-label={t('pos.lines.label')}>
        {lines.map((line, index) => (
          <LineRow
            // A tinted base can be on the bill twice, in two shades.
            key={`${line.variantId}:${line.tint?.shadeCode ?? ''}`}
            line={line}
            index={index}
            amountPaise={Number(amounts[index])}
            selected={index === selected}
            partyId={partyId}
            dispatch={lineDispatch}
          />
        ))}
      </ol>
    </>
  );
}
