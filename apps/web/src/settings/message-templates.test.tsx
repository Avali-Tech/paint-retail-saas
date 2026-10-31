import {
  DEFAULT_TEMPLATES,
  MESSAGE_CHANNELS,
  MESSAGE_LANGUAGES,
  TEMPLATE_KEYS,
  TEMPLATE_VARIABLES,
  type TemplateView,
} from '@paint/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';

/** Every template as the API lists it: the product's wording, or the business's own. */
function templates(own: Partial<Record<string, Partial<TemplateView>>> = {}): TemplateView[] {
  return TEMPLATE_KEYS.flatMap((key) =>
    MESSAGE_CHANNELS.flatMap((channel) =>
      MESSAGE_LANGUAGES.map((language) => ({
        key,
        channel,
        language,
        body: DEFAULT_TEMPLATES[key][language],
        variables: TEMPLATE_VARIABLES[key],
        custom: false,
        providerTemplateName: null,
        ...own[`${key}:${channel}:${language}`],
      })),
    ),
  );
}

const ORDER_READY_SMS_TE = 'order_ready:sms:te';

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  let current = templates();
  return {
    'GET /auth/me': () => json(OWNER),
    'GET /message-templates': () => json(current),
    'PUT /message-templates': (request) => {
      const body = request.body as TemplateView;
      if (body.body.includes('{{gstin}}')) {
        return json(
          {
            statusCode: 400,
            message: 'Validation failed',
            issues: [{ path: 'body', message: '{{gstin}} is not a variable of this message' }],
          },
          400,
        );
      }
      current = templates({
        [`${body.key}:${body.channel}:${body.language}`]: {
          body: body.body,
          custom: true,
          providerTemplateName: body.providerTemplateName,
        },
      });
      return json(current);
    },
    'DELETE /message-templates/:key/:channel/:language': () => {
      current = templates();
      return json(current);
    },
    ...overrides,
  };
}

describe('MessageTemplatesPage', { timeout: 30_000 }, () => {
  it('rewords a WhatsApp template with its own details, previews it and resets it', async () => {
    const { user, requests } = renderApp({ path: '/settings/messages', routes: routes() });
    expect(
      await screen.findByRole('heading', { name: 'Message templates', level: 1 }),
    ).toBeVisible();
    expect(await screen.findByText('Standard wording')).toBeVisible();
    expect(screen.getByText(/WhatsApp sends only wording your WhatsApp provider/)).toBeVisible();
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(preview).toHaveTextContent(
      'Dear Lakshmi, thank you for shopping at ABC Paints. Invoice AMP/26-27/000123 for ₹12,500.00. Pay by UPI: https://pay.example/l/AB12CD',
    );

    await user.selectOptions(screen.getByRole('combobox', { name: 'Message' }), 'order_ready');
    const body = screen.getByRole('textbox', { name: 'Message' });
    expect(body).toHaveValue(DEFAULT_TEMPLATES.order_ready.en);
    const details = screen.getByRole('group', { name: 'Details you can add' });
    expect(
      within(details)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['{{name}}', '{{business}}', '{{number}}']);
    // Saving needs a change.
    expect(screen.getByRole('button', { name: 'Save wording' })).toBeDisabled();

    await user.clear(body);
    expect(screen.getByText('The message cannot be empty')).toBeVisible();
    await user.type(body, 'Namaste  , order ready at {{{{business}}. GST {{{{gstin}}');
    expect(screen.getByText('{{gstin}} is not a detail of this message')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save wording' })).toBeDisabled();
    fireEvent.change(body, { target: { value: 'Namaste , order ready at {{business}}.' } });
    // The cursor after "Namaste ": the customer's name goes there.
    (body as HTMLTextAreaElement).setSelectionRange(8, 8);
    fireEvent.select(body);
    await user.click(within(details).getByRole('button', { name: 'Add {{name}}' }));
    expect(body).toHaveValue('Namaste {{name}}, order ready at {{business}}.');
    expect(screen.getByRole('region', { name: 'Preview' })).toHaveTextContent(
      'Namaste Lakshmi, order ready at ABC Paints.',
    );
    expect(screen.getByText('46 of 1000 characters')).toBeVisible();

    const provider = screen.getByRole('textbox', { name: 'Name at your WhatsApp provider' });
    await user.type(provider, 'Order Ready');
    expect(screen.getByText('Use lowercase letters, digits and _ only')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save wording' })).toBeDisabled();
    await user.clear(provider);
    await user.type(provider, 'order_ready_v2');
    await user.click(screen.getByRole('button', { name: 'Save wording' }));
    expect(await screen.findByText('Template saved')).toBeVisible();
    expect(requests.find((request) => request.method === 'PUT')?.body).toEqual({
      key: 'order_ready',
      channel: 'whatsapp',
      language: 'en',
      body: 'Namaste {{name}}, order ready at {{business}}.',
      providerTemplateName: 'order_ready_v2',
    });
    expect(await screen.findByText('Your wording')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Name at your WhatsApp provider' })).toHaveValue(
      'order_ready_v2',
    );

    await user.click(screen.getByRole('button', { name: 'Use standard wording' }));
    expect(await screen.findByText('Standard wording restored')).toBeVisible();
    expect(requests.at(-1)?.path).toBe('/message-templates/order_ready/whatsapp/en');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(
      DEFAULT_TEMPLATES.order_ready.en,
    );
    expect(screen.queryByRole('button', { name: 'Use standard wording' })).toBeNull();
  });

  it('shows an email’s subject, the other languages, and what the API refused', async () => {
    const { user } = renderApp({
      path: '/settings/messages',
      routes: routes({
        'GET /message-templates': () =>
          json(
            templates({
              [ORDER_READY_SMS_TE]: { custom: true, providerTemplateName: 'unused_on_sms' },
            }),
          ),
      }),
    });
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Sent by' }), 'email');
    expect(screen.getByRole('region', { name: 'Preview' })).toHaveTextContent(
      'Subject: Dear Lakshmi, thank you for shopping at ABC Paints.',
    );
    expect(screen.queryByText(/WhatsApp sends only wording/)).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Name at your WhatsApp provider' })).toBeNull();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Message' }), 'order_ready');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sent by' }), 'sms');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'te');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(
      DEFAULT_TEMPLATES.order_ready.te,
    );
    expect(screen.getByText('Your wording')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Preview' })).toHaveTextContent(
      'ప్రియమైన Lakshmi, ABC Paintsలో',
    );

    const body = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(body, { target: { value: 'x'.repeat(1001) } });
    expect(screen.getByText('Keep the message to 1000 characters')).toBeVisible();
    fireEvent.change(body, { target: { value: 'GST {{gstin}}' } });
    // The screen and the API agree; were they to differ, the API's answer is shown.
    expect(screen.getByRole('button', { name: 'Save wording' })).toBeDisabled();
    fireEvent.change(body, { target: { value: 'Ready: {{number}}' } });
    await user.click(screen.getByRole('button', { name: 'Save wording' }));
    expect(await screen.findByText('Template saved')).toBeVisible();
  });

  it('shows the API’s refusal of a wording', async () => {
    const { user } = renderApp({
      path: '/settings/messages',
      routes: routes({
        'PUT /message-templates': () =>
          json(
            {
              statusCode: 400,
              message: 'Validation failed',
              issues: [{ path: 'body', message: '{{gstin}} is not a variable of this message' }],
            },
            400,
          ),
      }),
    });
    const body = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(body, { target: { value: 'Hello {{name}}' } });
    await user.click(screen.getByRole('button', { name: 'Save wording' }));
    expect(
      await screen.findByText('Validation failed: {{gstin}} is not a variable of this message'),
    ).toBeVisible();
  });

  it('says when a template is missing, or the list cannot be read', async () => {
    const { unmount } = renderApp({
      path: '/settings/messages',
      routes: routes({ 'GET /message-templates': () => json([]) }),
    });
    expect(await screen.findByText('This message has no template yet.')).toBeVisible();
    unmount();
    renderApp({
      path: '/settings/messages',
      routes: routes({ 'GET /message-templates': () => json({ message: 'Down' }, 500) }),
    });
    expect(await screen.findByText('Could not load the message templates')).toBeVisible();
  });

  it('is for owners and admins only', async () => {
    renderApp({
      path: '/settings/messages',
      routes: { 'GET /auth/me': () => json(profile(['parties:read'])) },
    });
    expect(await screen.findByText('No access')).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Message templates' })).toBeNull();
    });
  });
});
