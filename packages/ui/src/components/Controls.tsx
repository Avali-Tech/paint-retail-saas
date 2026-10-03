import type { ComponentProps, ReactNode } from 'react';
import { Button } from './Button.js';
import { cx } from './cx.js';

export interface CheckboxProps extends Omit<ComponentProps<'input'>, 'type'> {
  readonly label: ReactNode;
}

/** A native checkbox with its label; the whole row is the touch target. */
export function Checkbox({ label, className, ...props }: CheckboxProps) {
  return (
    <label className={cx('ui-checkbox', className)}>
      <input {...props} type="checkbox" />
      <span>{label}</span>
    </label>
  );
}

export interface PaginationProps {
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly onChange: (offset: number) => void;
  /** Names the navigation, e.g. "Customer pages". */
  readonly label: string;
  /** e.g. (from, to, total) => "1–50 of 230". */
  readonly range: (from: number, to: number, total: number) => string;
  readonly previousLabel?: string;
  readonly nextLabel?: string;
}

/** Previous and next pages of a list, with where the visitor is in it. Hidden for a single page. */
export function Pagination({
  offset,
  limit,
  total,
  onChange,
  label,
  range,
  previousLabel = 'Previous',
  nextLabel = 'Next',
}: PaginationProps) {
  if (total <= limit && offset === 0) return null;
  const to = Math.min(offset + limit, total);
  return (
    <nav className="ui-pagination" aria-label={label}>
      <span className="ui-pagination__range">{range(Math.min(offset + 1, total), to, total)}</span>
      <Button
        variant="secondary"
        size="sm"
        disabled={offset === 0}
        onClick={() => {
          onChange(Math.max(0, offset - limit));
        }}
      >
        {previousLabel}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={to >= total}
        onClick={() => {
          onChange(offset + limit);
        }}
      >
        {nextLabel}
      </Button>
    </nav>
  );
}
