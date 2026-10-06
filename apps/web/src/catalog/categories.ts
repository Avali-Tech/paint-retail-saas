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

/**
 * Categories that take new products, as the API decides: active, and (for a
 * subcategory) under an active category. `keep` stays on the list even when it
 * does not, so a product already in it shows its category.
 */
export function usableCategories(categories: readonly Category[], keep: string | null): Category[] {
  const active = new Map(categories.map((category) => [category.id, category.isActive]));
  return categories.filter(
    (category) =>
      category.id === keep ||
      (category.isActive && (category.parentId === null || active.get(category.parentId) === true)),
  );
}

/** True when a category takes no new products only because its parent is inactive. */
export function inactiveThroughParent(
  category: Category,
  categories: readonly Category[],
): boolean {
  const parent = categories.find((candidate) => candidate.id === category.parentId);
  return category.isActive && parent?.isActive === false;
}
