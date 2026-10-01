import { act, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Dialog,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from './Overlays.js';
import { ToastProvider, useToast } from './Toast.js';
import { found } from '../test-support/found.js';

function DialogDemo({ description }: { description?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Choose a business"
        {...(description === undefined ? {} : { description })}
        footer={<button type="button">Continue</button>}
      >
        <p>Body text</p>
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('opens as a labelled modal and closes with Escape or the close button', async () => {
    const user = userEvent.setup();
    render(<DialogDemo description="You belong to two businesses" />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Choose a business' });
    expect(dialog).toHaveAccessibleDescription('You belong to two businesses');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('works without a description or footer', async () => {
    const user = userEvent.setup();
    render(
      <Dialog open onOpenChange={vi.fn()} title="Plain" closeLabel="Shut">
        Content
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'Plain' })).not.toHaveAttribute('aria-describedby');
    expect(document.querySelector('.ui-dialog__footer')).toBeNull();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Shut' })).toBeInTheDocument();
  });
});

describe('Popover', () => {
  it('opens next to its trigger', async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger>Notifications</PopoverTrigger>
        <PopoverContent aria-label="Notification list" className="wide">
          <p>Nothing new</p>
          <PopoverClose>Done</PopoverClose>
        </PopoverContent>
      </Popover>,
    );
    await user.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.getByText('Nothing new').closest('.ui-popover')).toHaveClass('wide');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('Nothing new')).toBeNull();
  });
});

describe('Tabs', () => {
  it('switches panels with the arrow keys', async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="password" className="sign-in">
        <TabsList aria-label="How to sign in" className="list">
          <TabsTrigger value="password" className="trigger">
            Password
          </TabsTrigger>
          <TabsTrigger value="otp">Mobile code</TabsTrigger>
        </TabsList>
        <TabsContent value="password" className="panel">
          Password form
        </TabsContent>
        <TabsContent value="otp">Code form</TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Password form');
    await user.click(screen.getByRole('tab', { name: 'Password' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Mobile code' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Code form');
    expect(screen.getByRole('tablist')).toHaveClass('ui-tabs__list', 'list');
  });
});

function ToastButtons() {
  const toast = useToast();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          toast({ title: 'Saved', description: 'Branding updated', tone: 'success' });
        }}
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => {
          toast({ title: 'Failed', tone: 'danger' });
        }}
      >
        Fail
      </button>
      <button
        type="button"
        onClick={() => {
          toast({ title: 'Plain' });
        }}
      >
        Plain
      </button>
    </>
  );
}

describe('Toast', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows messages in a live region and dismisses them', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ToastButtons />
      </ToastProvider>,
    );
    const region = screen.getByRole('region', { name: 'Messages' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('status')).toHaveTextContent('SavedBranding updated');
    await user.click(screen.getByRole('button', { name: 'Fail' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Failed');
    await user.click(screen.getByRole('button', { name: 'Plain' }));
    expect(screen.getByText('Plain', { selector: 'strong' }).closest('.ui-toast')).toHaveAttribute(
      'data-tone',
      'info',
    );
    const saved = found(screen.getByText('Branding updated').closest<HTMLElement>('.ui-toast'));
    await user.click(within(saved).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Branding updated')).toBeNull();
  });

  it('dismisses on its own after a while', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider duration={1000} regionLabel="Updates" dismissLabel="Hide">
        <ToastButtons />
      </ToastProvider>,
    );
    act(() => {
      screen.getByRole('button', { name: 'Save' }).click();
    });
    expect(screen.getByRole('button', { name: 'Hide' })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('refuses useToast outside the provider', () => {
    expect(() => renderHook(() => useToast())).toThrow(
      'useToast must be used inside <ToastProvider>',
    );
  });
});
