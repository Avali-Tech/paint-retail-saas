import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  FakeWorker,
  fakeServiceWorkers,
  fakeUpdateWindow,
} from '../test-support/fake-service-worker.js';
import { renderApp } from '../test-support/render-app.js';
import { UpdateBanner } from './UpdateBanner.js';
import { SKIP_WAITING, createUpdateController } from './updates.js';

async function setUp() {
  const workers = fakeServiceWorkers();
  const page = fakeUpdateWindow(workers.navigator);
  const updates = createUpdateController(page.win);
  await updates.register();
  const view = renderApp({ session: null, element: <UpdateBanner updates={updates} /> });
  const arrive = () => {
    const worker = new FakeWorker();
    act(() => {
      workers.found(worker);
      workers.installed(worker);
    });
    return worker;
  };
  return { ...view, ...page, arrive };
}

describe('UpdateBanner', () => {
  it('stays empty, but announced, until a new version has installed', async () => {
    await setUp();
    const region = screen.getByRole('region', { name: 'App updates' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();
  });

  it('offers the new version without taking focus, and reloads only when asked', async () => {
    const { arrive, user, reload } = await setUp();
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    const worker = arrive();
    expect(screen.getByText('A new version of the app is available.')).toBeInTheDocument();
    // Someone typing keeps typing: nothing moves focus or reloads.
    expect(field).toHaveFocus();
    expect(reload).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(worker.messages).toEqual([SKIP_WAITING]);
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveAttribute('aria-busy', 'true');
    field.remove();
  });

  it('hides until the next page load with "Later"', async () => {
    const { arrive, user } = await setUp();
    arrive();
    await user.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByText('A new version of the app is available.')).not.toBeInTheDocument();
  });
});
