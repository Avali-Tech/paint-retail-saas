import { z } from 'zod';

/** A whole number typed into a form, from `min` to `max`; `message` when it is not one. */
export function wholeNumber(min: number, max: number, message: string) {
  return z
    .string()
    .trim()
    .regex(/^-?\d+$/, message)
    .transform(Number)
    .refine((value) => value >= min && value <= max, message);
}
