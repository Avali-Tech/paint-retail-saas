import '../styles/customers.css';
import './contracts.css';
import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// Contracts. Each screen is its own chunk, loaded when first opened.
// The navigation entry is one of the core sections (shell/nav.ts).
const ContractsPage = lazy(() =>
  import('./ContractsPage.js').then((module) => ({ default: module.ContractsPage })),
);
const ContractDetailPage = lazy(() =>
  import('./ContractDetailPage.js').then((module) => ({ default: module.ContractDetailPage })),
);
const NewContractPage = lazy(() =>
  import('./ContractFormPage.js').then((module) => ({ default: module.NewContractPage })),
);
const EditContractPage = lazy(() =>
  import('./ContractFormPage.js').then((module) => ({ default: module.EditContractPage })),
);

/** The contract screens, inside the signed-in shell. */
export function contractRoutes() {
  return (
    <>
      <Route path="contracts" element={guarded('contracts:read', ContractsPage)} />
      <Route path="contracts/new" element={guarded('contracts:manage', NewContractPage)} />
      <Route path="contracts/:id" element={guarded('contracts:read', ContractDetailPage)} />
      <Route path="contracts/:id/edit" element={guarded('contracts:manage', EditContractPage)} />
    </>
  );
}
