/** One page of a list, as every paged API route answers. */
export interface Page<T> {
  readonly items: T[];
  readonly total: number;
}
