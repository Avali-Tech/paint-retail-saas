import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The theme guard: screens and components may only use design tokens, so a
 * business's branding restyles everything. This fails the build if a colour is
 * written anywhere in their sources (hex, rgb(), hsl(), oklch(), named colours).
 * Colours belong in packages/shared/src/theme.ts, which derives every token.
 */

// Vitest runs from the repository root.
const repo = process.cwd();
const GUARDED = ['apps/web/src', 'packages/ui/src'];

const COLOR_PATTERNS: readonly [string, RegExp][] = [
  ['hex colour', /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi],
  ['colour function', /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi],
  [
    'named colour',
    /:\s*(?:[^;{}]*\s)?(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy|teal|maroon)\b/gi,
  ],
];

function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return name === 'test-support' ? [] : sources(path);
    return /\.(css|tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every colour literal in a source, as "file:line: kind `text`". */
function findColorLiterals(file: string, text: string): string[] {
  const css = file.endsWith('.css');
  return text.split('\n').flatMap((line, index) =>
    COLOR_PATTERNS.flatMap(([kind, pattern]) =>
      // Named colours are only checked in stylesheets, where they would be values.
      kind === 'named colour' && !css
        ? []
        : [...line.matchAll(pattern)].map(
            (match) => `${file}:${String(index + 1)}: ${kind} \`${match[0]}\``,
          ),
    ),
  );
}

describe('theme guard', () => {
  it('finds colour literals of every kind', () => {
    expect(findColorLiterals('a.tsx', "color: '#fff', bg: 'rgb(0 0 0)'")).toEqual([
      'a.tsx:1: hex colour `#fff`',
      'a.tsx:1: colour function `rgb(`',
    ]);
    expect(findColorLiterals('a.css', '.x {\n  border: 1px solid white;\n}')).toEqual([
      'a.css:2: named colour `: 1px solid white`',
    ]);
    expect(
      findColorLiterals('a.css', '.x { color: var(--color-text); fill: currentColor; }'),
    ).toEqual([]);
    // Words in scripts are fine ("blue" as a message), and so are href="#main" anchors.
    expect(findColorLiterals('a.tsx', "label: 'Red lead', href: '#main'")).toEqual([]);
  });

  it('keeps every colour in the theme tokens', () => {
    const files = GUARDED.flatMap((folder) => sources(join(repo, folder)));
    expect(files.length).toBeGreaterThan(20);
    const found = files.flatMap((file) =>
      findColorLiterals(relative(repo, file), readFileSync(file, 'utf8')),
    );
    expect(found).toEqual([]);
  });
});
