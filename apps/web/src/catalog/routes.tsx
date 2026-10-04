import '../styles/inventory.css';
import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// Catalogue screens, each its own chunk loaded when first opened.
const ProductsPage = lazy(() =>
  import('./ProductsPage.js').then((module) => ({ default: module.ProductsPage })),
);
const ProductDetailPage = lazy(() =>
  import('./ProductDetailPage.js').then((module) => ({ default: module.ProductDetailPage })),
);
const NewProductPage = lazy(() =>
  import('./ProductFormPage.js').then((module) => ({ default: module.NewProductPage })),
);
const EditProductPage = lazy(() =>
  import('./ProductFormPage.js').then((module) => ({ default: module.EditProductPage })),
);
const CatalogSetupPage = lazy(() =>
  import('./CatalogSetupPage.js').then((module) => ({ default: module.CatalogSetupPage })),
);

/** The catalogue screens, inside the signed-in shell. */
export function catalogRoutes() {
  return (
    <>
      <Route path="products" element={guarded('catalog:read', ProductsPage)} />
      <Route path="products/new" element={guarded('catalog:manage', NewProductPage)} />
      <Route path="products/setup" element={guarded('catalog:read', CatalogSetupPage)} />
      <Route path="products/:id" element={guarded('catalog:read', ProductDetailPage)} />
      <Route path="products/:id/edit" element={guarded('catalog:manage', EditProductPage)} />
    </>
  );
}
