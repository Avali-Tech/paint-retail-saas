import { createContext, use, useId, type ComponentProps, type ReactNode } from 'react';
import { cx } from './cx.js';

/** Props a form control needs to be labelled and described by its Field. */
export interface FieldControlProps {
  readonly id: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: true;
  readonly 'aria-required'?: true;
}

const FieldContext = createContext<FieldControlProps | null>(null);

/** Inside a Field: the id and ARIA attributes for its control. */
export function useFieldControl(): FieldControlProps | null {
  return use(FieldContext);
}

export interface FieldProps {
  readonly label: ReactNode;
  readonly children: ReactNode;
  /** Help shown under the control. */
  readonly hint?: ReactNode;
  /** Shown instead of nothing when the value is wrong; marks the control invalid. */
  readonly error?: string | undefined;
  readonly required?: boolean;
  readonly id?: string;
  readonly className?: string;
}

/** A label, a control (Input, Select, Textarea), help text and an error message, all linked for screen readers. */
export function Field({
  label,
  children,
  hint,
  error,
  required = false,
  id,
  className,
}: FieldProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const hintId = hint === undefined ? undefined : `${controlId}-hint`;
  const errorId = error === undefined ? undefined : `${controlId}-error`;
  const describedBy = [hintId, errorId].filter((part) => part !== undefined).join(' ');
  const control: FieldControlProps = {
    id: controlId,
    ...(describedBy === '' ? {} : { 'aria-describedby': describedBy }),
    ...(error === undefined ? {} : { 'aria-invalid': true }),
    ...(required ? { 'aria-required': true } : {}),
  };
  return (
    <div className={cx('ui-field', className)} data-invalid={error === undefined ? undefined : ''}>
      <label htmlFor={controlId} className="ui-field__label">
        {label}
        {required && (
          <span className="ui-field__required" aria-hidden="true">
            {' *'}
          </span>
        )}
      </label>
      <FieldContext value={control}>{children}</FieldContext>
      {hint !== undefined && (
        <p id={hintId} className="ui-field__hint">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={errorId} className="ui-field__error">
          {error}
        </p>
      )}
    </div>
  );
}

export type InputProps = ComponentProps<'input'>;

export function Input({ className, ...props }: InputProps) {
  const control = useFieldControl();
  return <input {...control} {...props} className={cx('ui-input', className)} />;
}

export type TextareaProps = ComponentProps<'textarea'>;

export function Textarea({ className, ...props }: TextareaProps) {
  const control = useFieldControl();
  return <textarea {...control} {...props} className={cx('ui-input', 'ui-textarea', className)} />;
}

export type SelectProps = ComponentProps<'select'>;

/** The device's own picker: the easiest choice on a phone. */
export function Select({ className, ...props }: SelectProps) {
  const control = useFieldControl();
  return <select {...control} {...props} className={cx('ui-input', 'ui-select', className)} />;
}
