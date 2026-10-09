import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { landFocus, useLandingOnChange, usePageLanding } from './focus-landing.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Page({ settled, view }: { readonly settled: boolean; readonly view?: unknown }) {
  usePageLanding(settled, view);
  return (
    <>
      <h1>Sales order SO-000017</h1>
      <button type="button">Bill</button>
    </>
  );
}

function Part({ view }: { readonly view: string }) {
  const target = useRef<HTMLButtonElement>(null);
  useLandingOnChange(view, target);
  return (
    <button ref={target} type="button">
      Add room
    </button>
  );
}

describe('landFocus', () => {
  it('puts focus lost to the page on the heading, which takes it only from script', () => {
    render(<Page settled={false} />);
    const heading = screen.getByRole('heading', { level: 1 });
    landFocus();
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('leaves the focus where it is when something has it', () => {
    render(<Page settled={false} />);
    const bill = screen.getByRole('button', { name: 'Bill' });
    bill.focus();
    landFocus();
    expect(bill).toHaveFocus();
  });

  it('lands on a control as it is, and on nothing when the page has no heading', () => {
    render(<button type="button">Change</button>);
    const change = screen.getByRole('button', { name: 'Change' });
    landFocus();
    expect(document.body).toHaveFocus();
    landFocus(change);
    expect(change).toHaveFocus();
    expect(change).not.toHaveAttribute('tabindex');
  });

  it('treats no focused element at all as lost', () => {
    render(<Page settled={false} />);
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(null);
    landFocus();
    vi.restoreAllMocks();
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });
});

describe('usePageLanding', () => {
  it('lands a tick after the page appears or settles, not while a dialog is open', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Page settled={false} view={1} />);
    act(() => {
      vi.runAllTimers();
    });
    expect(document.body).toHaveFocus();
    rerender(<Page settled view={1} />);
    expect(document.body).toHaveFocus();
    act(() => {
      vi.runAllTimers();
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });

  it('checks again when what the page shows changes, and forgets a check it no longer needs', () => {
    vi.useFakeTimers();
    const { rerender, unmount } = render(<Page settled view={1} />);
    act(() => {
      vi.runAllTimers();
    });
    const heading = screen.getByRole('heading', { level: 1 });
    heading.blur();
    rerender(<Page settled view={2} />);
    act(() => {
      vi.runAllTimers();
    });
    expect(heading).toHaveFocus();
    heading.blur();
    rerender(<Page settled view={3} />);
    unmount();
    act(() => {
      vi.runAllTimers();
    });
    expect(document.body).toHaveFocus();
  });
});

describe('useLandingOnChange', () => {
  it('does nothing when the part appears, and lands on its target when the view changes', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Part view="2 rooms" />);
    act(() => {
      vi.runAllTimers();
    });
    expect(document.body).toHaveFocus();
    rerender(<Part view="2 rooms" />);
    act(() => {
      vi.runAllTimers();
    });
    expect(document.body).toHaveFocus();
    rerender(<Part view="1 room" />);
    act(() => {
      vi.runAllTimers();
    });
    expect(screen.getByRole('button', { name: 'Add room' })).toHaveFocus();
  });
});
