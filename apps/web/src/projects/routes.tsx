import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// Project screens (styles come with the lead routes), each its own chunk.
const ProjectsPage = lazy(() =>
  import('./ProjectsPage.js').then((module) => ({ default: module.ProjectsPage })),
);
const NewProjectPage = lazy(() =>
  import('./ProjectFormPage.js').then((module) => ({ default: module.NewProjectPage })),
);
const EditProjectPage = lazy(() =>
  import('./ProjectFormPage.js').then((module) => ({ default: module.EditProjectPage })),
);
const ProjectDetailPage = lazy(() =>
  import('./ProjectDetailPage.js').then((module) => ({ default: module.ProjectDetailPage })),
);

/** The project screens, inside the signed-in shell. */
export function projectRoutes() {
  return (
    <>
      <Route path="projects" element={guarded('projects:read', ProjectsPage)} />
      <Route path="projects/new" element={guarded('projects:manage', NewProjectPage)} />
      <Route path="projects/:id" element={guarded('projects:read', ProjectDetailPage)} />
      <Route path="projects/:id/edit" element={guarded('projects:manage', EditProjectPage)} />
    </>
  );
}
