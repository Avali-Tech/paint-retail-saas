import { useId, type ComponentProps, type ReactNode } from 'react';
import { cx } from './cx.js';

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface CardProps extends Omit<ComponentProps<'section'>, 'title'> {
  readonly title?: ReactNode;
  /** Buttons or links shown next to the title. */
  readonly actions?: ReactNode;
}

/** A raised panel; with a title it becomes a labelled region. */
export function Card({ title, actions, children, className, ...props }: CardProps) {
  const headingId = useId();
  return (
    <section
      {...props}
      className={cx('ui-card', className)}
      aria-labelledby={title === undefined ? undefined : headingId}
    >
      {title !== undefined && (
        <header className="ui-card__header">
          <h2 id={headingId} className="ui-card__title">
            {title}
          </h2>
          {actions}
        </header>
      )}
      <div className="ui-card__body">{children}</div>
    </section>
  );
}

export interface TableProps extends ComponentProps<'table'> {
  /** Names the table for screen readers; wide tables scroll sideways on phones. */
  readonly label: string;
}

export function Table({ label, className, children, ...props }: TableProps) {
  const captionId = useId();
  return (
    // A focusable region named by the caption, so keyboard users can scroll a wide table.
    <div className="ui-table-wrap" role="region" aria-labelledby={captionId} tabIndex={0}>
      <table {...props} className={cx('ui-table', className)}>
        <caption id={captionId} className="ui-visually-hidden">
          {label}
        </caption>
        {children}
      </table>
    </div>
  );
}

export interface BadgeProps extends ComponentProps<'span'> {
  readonly tone?: Tone;
}

export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return <span {...props} className={cx('ui-badge', className)} data-tone={tone} />;
}

export interface AlertProps {
  readonly tone?: Exclude<Tone, 'neutral' | 'primary'>;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  /** E.g. a "Try again" button. */
  readonly action?: ReactNode;
}

/** A message in the page; errors are announced at once, others politely. */
export function Alert({ tone = 'info', title, children, action }: AlertProps) {
  return (
    <div className="ui-alert" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <div className="ui-alert__text">
        {title !== undefined && <strong className="ui-alert__title">{title}</strong>}
        {children}
      </div>
      {action}
    </div>
  );
}

export interface SpinnerProps {
  readonly label?: string;
  readonly size?: 'sm' | 'md' | 'lg';
}

export function Spinner({ label = 'Loading', size = 'md' }: SpinnerProps) {
  return <span className="ui-spinner" data-size={size} role="status" aria-label={label} />;
}

export interface SkeletonProps {
  readonly width?: string;
  readonly height?: string;
  readonly className?: string;
}

/** A grey placeholder shaped like the content that is loading. */
export function Skeleton({ width, height, className }: SkeletonProps) {
  return (
    <span className={cx('ui-skeleton', className)} style={{ width, height }} aria-hidden="true" />
  );
}

export interface PageHeaderProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="ui-page-header">
      <div className="ui-page-header__text">
        <h1 className="ui-page-header__title">{title}</h1>
        {description !== undefined && <p className="ui-page-header__description">{description}</p>}
      </div>
      {actions !== undefined && <div className="ui-page-header__actions">{actions}</div>}
    </header>
  );
}

export interface EmptyStateProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly icon?: ReactNode;
  readonly action?: ReactNode;
}

export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <div className="ui-empty">
      {icon !== undefined && <div className="ui-empty__icon">{icon}</div>}
      <p className="ui-empty__title">{title}</p>
      {description !== undefined && <p className="ui-empty__description">{description}</p>}
      {action}
    </div>
  );
}

export function VisuallyHidden({ children }: { readonly children: ReactNode }) {
  return <span className="ui-visually-hidden">{children}</span>;
}
