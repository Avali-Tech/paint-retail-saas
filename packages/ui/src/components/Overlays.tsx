import * as RadixDialog from '@radix-ui/react-dialog';
import * as RadixPopover from '@radix-ui/react-popover';
import * as RadixTabs from '@radix-ui/react-tabs';
import type { ComponentProps, ReactNode } from 'react';
import { cx } from './cx.js';
import { Icon } from './Icon.js';

export interface DialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  /** Buttons along the bottom. */
  readonly footer?: ReactNode;
  readonly closeLabel?: string;
}

/** A modal dialog: traps focus, closes on Escape, returns focus to where it was opened from. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  closeLabel = 'Close',
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ui-dialog__overlay" />
        <RadixDialog.Content
          className="ui-dialog"
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
        >
          <header className="ui-dialog__header">
            <RadixDialog.Title className="ui-dialog__title">{title}</RadixDialog.Title>
            <RadixDialog.Close className="ui-icon-button" aria-label={closeLabel}>
              <Icon name="close" />
            </RadixDialog.Close>
          </header>
          {description !== undefined && (
            <RadixDialog.Description className="ui-dialog__description">
              {description}
            </RadixDialog.Description>
          )}
          <div className="ui-dialog__body">{children}</div>
          {footer !== undefined && <footer className="ui-dialog__footer">{footer}</footer>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverClose = RadixPopover.Close;

/** Floating panel next to its trigger (e.g. the notification list). */
export function PopoverContent({
  className,
  children,
  ...props
}: ComponentProps<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        sideOffset={8}
        align="end"
        collisionPadding={8}
        {...props}
        className={cx('ui-popover', className)}
      >
        {children}
      </RadixPopover.Content>
    </RadixPopover.Portal>
  );
}

export function Tabs({ className, ...props }: ComponentProps<typeof RadixTabs.Root>) {
  return <RadixTabs.Root {...props} className={cx('ui-tabs', className)} />;
}

export function TabsList({ className, ...props }: ComponentProps<typeof RadixTabs.List>) {
  return <RadixTabs.List {...props} className={cx('ui-tabs__list', className)} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof RadixTabs.Trigger>) {
  return <RadixTabs.Trigger {...props} className={cx('ui-tabs__trigger', className)} />;
}

export function TabsContent({ className, ...props }: ComponentProps<typeof RadixTabs.Content>) {
  return <RadixTabs.Content {...props} className={cx('ui-tabs__content', className)} />;
}
