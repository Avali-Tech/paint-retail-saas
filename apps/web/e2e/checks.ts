import { expect, type Page } from '@playwright/test';
import { accessibilityProblems } from './support.js';

/**
 * Text is wider with some fonts than others (Linux CI's fonts are wider than macOS's).
 * Spacing every letter out by this much checks the layout still fits where text is wider.
 */
export const WIDE_TEXT_SPACING = '0.08em';

/**
 * The elements that stick out past the right edge of the page, deepest first, as
 * "tag.class “text” (+Npx)" lines; empty when the page does not scroll sideways.
 * Content inside its own scrolling box (a wide table) does not count.
 */
export async function sidewaysOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.documentElement;
    if (root.scrollWidth <= root.clientWidth) return [];
    const edge = root.clientWidth;
    const scrollsItself = (element: Element) =>
      ['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(element).overflowX);
    const sticksOut = (element: Element) => {
      if (element.getBoundingClientRect().right <= edge + 0.5) return false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent !== root && parent !== document.body && scrollsItself(parent)) return false;
      }
      return true;
    };
    const offenders = [...document.body.querySelectorAll('*')].filter(sticksOut);
    const deepest = offenders.filter(
      (element) => !offenders.some((other) => element.contains(other) && other !== element),
    );
    const lines = deepest.map((element) => {
      const name = [element.tagName.toLowerCase(), ...element.classList].join('.');
      const text = element.textContent.trim().replace(/\s+/g, ' ').slice(0, 40);
      const extra = Math.ceil(element.getBoundingClientRect().right - edge);
      return `${name} “${text}” (+${String(extra)}px)`;
    });
    return lines.length > 0 ? lines : [`the page is ${String(root.scrollWidth - edge)}px too wide`];
  });
}

/**
 * The page meets WCAG AA and does not scroll sideways, also with wider text than
 * this machine's fonts give (so a layout that only just fits on macOS fails here too).
 */
export async function expectUsable(page: Page): Promise<void> {
  expect(await accessibilityProblems(page)).toEqual([]);
  expect(await sidewaysOverflow(page), 'sticks out sideways').toEqual([]);
  const setWideText = (on: boolean) =>
    page.evaluate(
      ({ on, spacing }) => {
        document.getElementById('e2e-wide-text')?.remove();
        if (!on) return;
        const style = document.createElement('style');
        style.id = 'e2e-wide-text';
        style.textContent = `* { letter-spacing: ${spacing} !important; }`;
        document.head.append(style);
      },
      { on, spacing: WIDE_TEXT_SPACING },
    );
  await setWideText(true);
  try {
    expect(await sidewaysOverflow(page), 'sticks out sideways with wider text').toEqual([]);
  } finally {
    await setWideText(false);
  }
}
