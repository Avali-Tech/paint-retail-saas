/**
 * A small seeded random number generator (mulberry32), so the demo business is
 * the same every time it is created: same names, products, prices and stock.
 */
export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** A number in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** A whole number from `min` to `max`, both included. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('Cannot pick from an empty list');
    return item;
  }

  /** `count` different elements, in random order. */
  sample<T>(items: readonly T[], count: number): T[] {
    return this.shuffle(items).slice(0, count);
  }

  /** A shuffled copy (Fisher–Yates). */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index--) {
      const other = Math.floor(this.next() * (index + 1));
      [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
    }
    return copy;
  }

  /** `length` random digits as a string. */
  digits(length: number): string {
    return Array.from({ length }, () => String(this.int(0, 9))).join('');
  }

  /** `length` random capital letters. */
  letters(length: number): string {
    return Array.from({ length }, () => String.fromCharCode(65 + this.int(0, 25))).join('');
  }
}
