import {
  TEMPLATE_MAX_LENGTH,
  TEMPLATE_VARIABLES,
  emailParts,
  payLinkText,
  renderTemplate,
  variablesIn,
  type MessageChannel,
  type MessageLanguage,
  type TemplateKey,
} from '@paint/shared';

// The message templates screen's checks and preview: the same rules the API applies
// when a template is saved (MSG-4: only the template's own variables), shown as the
// member types, and the message as a customer would read it, filled with sample data.

/** Why a wording cannot be saved. */
export type TemplateIssue =
  | { readonly kind: 'empty' }
  | { readonly kind: 'tooLong'; readonly max: number }
  | { readonly kind: 'unknown'; readonly name: string };

/** The problems with a wording for one template (as `templateProblems` on the API). */
export function templateIssues(key: TemplateKey, body: string): TemplateIssue[] {
  const allowed = new Set(TEMPLATE_VARIABLES[key]);
  return [
    ...(body.trim() === '' ? [{ kind: 'empty' } as const] : []),
    ...(body.length > TEMPLATE_MAX_LENGTH
      ? [{ kind: 'tooLong', max: TEMPLATE_MAX_LENGTH } as const]
      : []),
    ...variablesIn(body)
      .filter((name) => !allowed.has(name))
      .map((name) => ({ kind: 'unknown', name }) as const),
  ];
}

/** Sample values a preview fills in; the names and wording come from the screen's language. */
export interface PreviewSample {
  readonly name: string;
  readonly business: string;
  readonly link: string;
}

/** A sample UPI payment link, to show where `{{payLink}}` goes. */
export const SAMPLE_PAY_URL = 'https://pay.example/l/AB12CD';

/** Every variable a template may use, filled with sample data. */
export function sampleVariables(
  language: MessageLanguage,
  sample: PreviewSample,
): Record<string, string> {
  return {
    name: sample.name,
    business: sample.business,
    number: 'AMP/26-27/000123',
    amount: '₹12,500.00',
    from: '01-10-2026',
    to: '31-10-2026',
    dueOn: '15-11-2026',
    days: '12',
    promisedOn: '20-11-2026',
    link: sample.link,
    payLink: payLinkText(SAMPLE_PAY_URL, language),
    points: '125',
    balance: '940',
  };
}

/** The message as the customer reads it: an email also has a subject. */
export function previewOf(
  body: string,
  channel: MessageChannel,
  variables: Readonly<Record<string, string>>,
): { readonly subject: string | null; readonly text: string } {
  const text = renderTemplate(body, variables);
  return channel === 'email' ? emailParts(text) : { subject: null, text };
}
