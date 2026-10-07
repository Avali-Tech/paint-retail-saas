import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OrganizationIdentity } from '../api/types.js';
import { OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { IDENTITY_KEY } from '../theme/identity-source.js';
import { MAX_LOGO_BYTES, logoProblem } from './IdentitySettings.js';

const LOGO = {
  url: '/public/branding/sharma-paints/logo/0123456789abcdef',
  contentType: 'image/png',
  width: 120,
  height: 40,
  sizeBytes: 812,
  updatedAt: '2026-10-07T06:00:00.000Z',
};
const PLAIN: OrganizationIdentity = { slug: 'sharma-paints', logo: null };

const png = (name = 'logo.png', size = 64) =>
  new File([new Uint8Array(size)], name, { type: 'image/png' });

function renderSettings(routes: Record<string, FakeHandler> = {}) {
  return renderApp({
    path: '/settings/appearance',
    routes: {
      'GET /auth/me': () => json(OWNER),
      'GET /organization/identity': () => json(PLAIN),
      ...routes,
    },
  });
}

const logoCard = async () => within(await screen.findByRole('region', { name: 'Logo' }));
const linkCard = async () => within(await screen.findByRole('region', { name: 'Sign-in link' }));
const fileInput = (card: Awaited<ReturnType<typeof logoCard>>) =>
  card.getByLabelText('Logo file', { selector: 'input' });

describe('logoProblem', () => {
  it('catches what the browser can tell before sending', () => {
    expect(logoProblem(png('a.png', 0))).toBe('empty_file');
    expect(logoProblem(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }))).toBe(
      'svg_not_allowed',
    );
    expect(logoProblem(new File(['<svg/>'], 'LOGO.SVG'))).toBe('svg_not_allowed');
    expect(logoProblem(png('big.png', MAX_LOGO_BYTES + 1))).toBe('too_large');
    expect(logoProblem(png())).toBeNull();
  });
});

describe('the logo settings', { timeout: 30_000 }, () => {
  it('waits for the business’s logo and link before showing them', async () => {
    renderSettings({ 'GET /organization/identity': () => new Promise(() => undefined) });
    expect(await screen.findByText('Loading your logo and sign-in link…')).toBeInTheDocument();
  });

  it('uploads a logo, shows it on light and dark samples and in the header, then removes it', async () => {
    const { user, requests } = renderSettings({
      'POST /organization/logo': () => json({ slug: 'sharma-paints', logo: LOGO }, 201),
      'DELETE /organization/logo': () => json(PLAIN),
    });
    const card = await logoCard();
    expect(
      card.getByText('No logo yet: the first letter of the app name shows instead.'),
    ).toBeVisible();
    expect(card.queryByRole('button', { name: 'Remove logo' })).toBeNull();

    await user.click(card.getByRole('button', { name: 'Upload logo' }));
    expect(card.getByText('Choose a picture to upload')).toBeVisible();
    await user.upload(fileInput(card), png());
    expect(card.queryByText('Choose a picture to upload')).toBeNull();
    await user.click(card.getByRole('button', { name: 'Upload logo' }));

    expect(await screen.findByText('Logo saved')).toBeInTheDocument();
    const samples = card.getByRole('group', { name: 'How the logo looks' });
    expect(within(samples).getByText('On a light page')).toBeVisible();
    expect(within(samples).getByText('On a dark page')).toBeVisible();
    expect(samples.querySelectorAll('img')).toHaveLength(2);
    expect(document.querySelector('.shell__brand img')).toHaveAttribute('src', `/api${LOGO.url}`);
    expect(JSON.parse(String(localStorage.getItem(IDENTITY_KEY)))).toMatchObject({ logo: LOGO });
    expect(requests.find((request) => request.method === 'POST')?.body).toBeInstanceOf(FormData);

    await user.click(card.getByRole('button', { name: 'Remove logo' }));
    expect(await screen.findByText('Logo removed')).toBeInTheDocument();
    expect(document.querySelector('.shell__brand img')).toBeNull();
    expect(
      card.getByText('No logo yet: the first letter of the app name shows instead.'),
    ).toBeVisible();
  });

  it('refuses SVG, empty and oversized files before sending them', async () => {
    const { user, requests } = renderSettings();
    const card = await logoCard();
    const input = fileInput(card);
    // The file input only offers pictures; a dropped or pasted file can still be anything.
    fireEvent.change(input, {
      target: { files: [new File(['<svg onload="x"/>'], 'logo.svg', { type: 'image/svg+xml' })] },
    });
    await user.click(card.getByRole('button', { name: 'Upload logo' }));
    expect(
      card.getByText(
        'SVG logos are not accepted, because they can carry hidden scripts. Save the logo as a PNG (with a transparent background), JPEG or WebP.',
      ),
    ).toBeVisible();
    fireEvent.change(input, { target: { files: [png('big.png', MAX_LOGO_BYTES + 1)] } });
    await user.click(card.getByRole('button', { name: 'Upload logo' }));
    expect(
      card.getByText('This picture is larger than 1 MB. Save it smaller and try again.'),
    ).toBeVisible();
    fireEvent.change(input, { target: { files: [] } });
    await user.click(card.getByRole('button', { name: 'Upload logo' }));
    expect(card.getByText('Choose a picture to upload')).toBeVisible();
    expect(requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it('explains the server’s refusals by their code, and other failures by their message', async () => {
    let answer = json(
      {
        statusCode: 422,
        code: 'dimensions',
        message: 'Logos must be 16 to 2048 pixels wide and high',
      },
      422,
    );
    const { user } = renderSettings({ 'POST /organization/logo': () => answer });
    const card = await logoCard();
    await user.upload(fileInput(card), png());

    await user.click(card.getByRole('button', { name: 'Upload logo' }));
    expect(
      await card.findByText('The picture must be 16 to 2048 pixels wide and high.'),
    ).toBeVisible();

    answer = json({ statusCode: 422, code: 'virus_found', message: 'Eicar-Signature found' }, 422);
    await user.click(card.getByRole('button', { name: 'Upload logo' }));
    expect(await card.findByText('The file was refused: Eicar-Signature found')).toBeVisible();

    answer = json({ statusCode: 500, message: 'Something broke' }, 500);
    await user.click(card.getByRole('button', { name: 'Upload logo' }));
    expect(await card.findByText('Something broke')).toBeVisible();
  });
});

describe('the sign-in link settings', { timeout: 30_000 }, () => {
  it('shows the link to copy, and copies it', async () => {
    const { user } = renderSettings();
    const card = await linkCard();
    const link = card.getByRole('textbox', { name: 'Your sign-in link' });
    expect(link).toHaveValue(`${window.location.origin}/sign-in?b=sharma-paints`);
    expect(link).toHaveAttribute('readonly');
    fireEvent.focus(link);

    await user.click(card.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(
      `${window.location.origin}/sign-in?b=sharma-paints`,
    );

    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    await user.click(card.getByRole('button', { name: 'Copy link' }));
    expect(
      await screen.findByText('Could not copy. Select the link and copy it.'),
    ).toBeInTheDocument();
  });

  it('checks the name as the API does, saves it, and the link follows', async () => {
    let answer: (slug: string) => ReturnType<FakeHandler> = (slug) => json({ slug, logo: null });
    const { user, requests } = renderSettings({
      'PUT /organization/slug': (request) => answer((request.body as { slug: string }).slug),
    });
    const card = await linkCard();
    const name = card.getByRole('textbox', { name: 'Link name' });

    for (const [typed, message] of [
      ['ab', 'Use 3 to 40 characters'],
      [
        'Sharma Paints!',
        'Use lower-case letters, digits and single hyphens, not at the start or end',
      ],
      ['platform', 'This name is reserved. Choose another.'],
    ] as const) {
      await user.clear(name);
      await user.type(name, typed);
      await user.click(card.getByRole('button', { name: 'Save link name' }));
      expect(name).toHaveAccessibleDescription(
        `Lower-case letters, digits and hyphens, e.g. sharma-paints ${message}`,
      );
    }
    expect(requests.filter((request) => request.method === 'PUT')).toEqual([]);

    answer = () =>
      json(
        {
          statusCode: 409,
          code: 'taken',
          message: 'Another business uses this sign-in link. Choose another.',
        },
        409,
      );
    await user.clear(name);
    await user.type(name, 'xyz-paints');
    await user.click(card.getByRole('button', { name: 'Save link name' }));
    expect(
      await card.findByText('Another business uses this link name. Choose another.'),
    ).toBeVisible();

    answer = () => json({ statusCode: 503, message: 'Database down' }, 503);
    await user.click(card.getByRole('button', { name: 'Save link name' }));
    expect(await card.findByText('Database down')).toBeVisible();

    answer = (slug) => json({ slug, logo: null });
    await user.clear(name);
    await user.type(name, ' Sharma-Hyd ');
    await user.click(card.getByRole('button', { name: 'Save link name' }));
    expect(await screen.findByText('Sign-in link saved')).toBeInTheDocument();
    expect(requests.filter((request) => request.method === 'PUT').at(-1)?.body).toEqual({
      slug: 'sharma-hyd',
    });
    await waitFor(async () => {
      expect((await linkCard()).getByRole('textbox', { name: 'Your sign-in link' })).toHaveValue(
        `${window.location.origin}/sign-in?b=sharma-hyd`,
      );
    });
  });
});
