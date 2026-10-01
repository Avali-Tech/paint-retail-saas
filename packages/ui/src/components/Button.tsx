import type { ComponentProps } from 'react';
import { cx } from './cx.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends ComponentProps<'button'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Shows a spinner and blocks clicks while work is in progress. */
  readonly loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  type = 'button',
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={cx('ui-button', className)}
      data-variant={variant}
      data-size={size}
      disabled={disabled || loading}
      aria-busy={loading ? true : undefined}
    >
      {loading && <span className="ui-spinner" data-size="sm" aria-hidden="true" />}
      {children}
    </button>
  );
}

/** Attributes that make a link (e.g. a router Link) look like a Button. */
export function buttonStyle(variant: ButtonVariant = 'primary', size: ButtonSize = 'md') {
  return { className: 'ui-button', 'data-variant': variant, 'data-size': size } as const;
}
