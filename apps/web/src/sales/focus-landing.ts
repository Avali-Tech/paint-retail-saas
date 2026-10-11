import { useEffect, useRef, type RefObject } from 'react';

/**
 * Moves the focus to `target`, or the page's heading, when it has been lost to the
 * page itself: the button that had it went away with what it did (a dialog's action
 * changed the page, or moved to a new one).
 */
export function landFocus(target?: HTMLElement | null): void {
  const active = document.activeElement;
  if (active !== null && active !== document.body) return;
  const landing = target ?? document.querySelector<HTMLElement>('h1');
  if (landing === null) return;
  // A heading takes focus only from script; a control keeps its place in the tab order.
  if (landing.tabIndex < 0) landing.tabIndex = -1;
  landing.focus();
}

/** A tick later, after a closing dialog has tried to hand the focus back to its button. */
function landSoon(target?: RefObject<HTMLElement | null>): () => void {
  const timer = window.setTimeout(() => {
    landFocus(target?.current);
  }, 0);
  return () => {
    window.clearTimeout(timer);
  };
}

/**
 * For a page: when it appears, when its dialog closes (`settled` turns true) and when
 * what it shows changes (`view`), focus lost to the page lands on its heading.
 */
export function usePageLanding(settled: boolean, view?: unknown): void {
  useEffect(() => (settled ? landSoon() : undefined), [settled, view]);
}

/**
 * For a part of a page: when `view` changes (not when the part first appears), focus
 * lost to the page lands on `target`.
 */
export function useLandingOnChange(view: unknown, target: RefObject<HTMLElement | null>): void {
  const previous = useRef(view);
  useEffect(() => {
    if (Object.is(previous.current, view)) return;
    previous.current = view;
    return landSoon(target);
  }, [view, target]);
}
