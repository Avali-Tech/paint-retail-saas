import { NotFoundException } from '@nestjs/common';

/** The single row of a lookup by id, or a 404 naming what was missing. */
export function only<T>(rows: T[], what: string): T {
  const [row] = rows;
  if (row === undefined) throw new NotFoundException(`${what} not found`);
  return row;
}
