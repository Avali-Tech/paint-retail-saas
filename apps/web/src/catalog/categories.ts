import type { Category } from '../api/catalog.js';

export interface CategoryOption {
  readonly id: string;
  /** "Emulsions › Interior emulsions" for a subcategory, the name for a top-level one. */
  readonly label: string;
}

/** Categories for a picker: each top-level one followed by its subcategories. */
export function categoryOptions(categories: readonly Category[]): CategoryOption[] {
  return categories
    .filter((category) => category.parentId === null)
    .flatMap((parent) => [
      { id: parent.id, label: parent.name },
      ...categories
        .filter((child) => child.parentId === parent.id)
        .map((child) => ({ id: child.id, label: `${parent.name} › ${child.name}` })),
    ]);
}
