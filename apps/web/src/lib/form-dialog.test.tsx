import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors.js';
import { createI18n } from '../i18n/i18n.js';
import { FormDialog } from './FormDialog.js';

describe('FormDialog', () => {
  it('stays open on false or a message, shows API errors, and closes once saved', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const answers: (() => Promise<string | false | undefined>)[] = [
      () => Promise.resolve(false),
      () => Promise.resolve('Fix the amount'),
      () => Promise.reject(new ApiError(409, 'Already done')),
      () => Promise.resolve(undefined),
    ];
    render(
      <FormDialog
        open
        onClose={onClose}
        title="Pay"
        submitLabel="Send"
        onSubmit={() => answers.shift()?.() ?? undefined}
      >
        <p>Fields</p>
      </FormDialog>,
    );
    const send = screen.getByRole('button', { name: 'Send' });
    await user.click(send);
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(send);
    expect(await screen.findByRole('alert')).toHaveTextContent('Fix the amount');
    await user.click(send);
    expect(await screen.findByText('Already done')).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(send);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('label', () => {
  it('names API values, and humanizes ones without a name yet', () => {
    const { label } = createI18n('en');
    expect(label('partyRoles', 'sub_dealer')).toBe('Sub-dealer');
    expect(label('partyRoles', 'paint_mixer')).toBe('Paint mixer');
  });
});
