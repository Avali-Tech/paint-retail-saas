import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button, buttonStyle } from './Button.js';
import { cx } from './cx.js';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  Spinner,
  Table,
  VisuallyHidden,
} from './Display.js';
import { Field, Input, Select, Textarea } from './Field.js';
import { ICON_NAMES, Icon } from './Icon.js';

describe('cx', () => {
  it('joins the class names that are set', () => {
    expect(cx('a', undefined, false, null, '', 'b')).toBe('a b');
  });
});

describe('Button', () => {
  it('is a primary button by default and handles clicks', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('data-variant', 'primary');
    expect(button).toHaveAttribute('data-size', 'md');
    expect(button).not.toHaveAttribute('aria-busy');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('blocks clicks and shows progress while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button loading variant="danger" size="sm" type="submit" className="wide" onClick={onClick}>
        Delete
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('type', 'submit');
    expect(button).toHaveClass('ui-button', 'wide');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('can be disabled', () => {
    render(<Button disabled>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled();
  });

  it('lends its look to links', () => {
    expect(buttonStyle()).toEqual({
      className: 'ui-button',
      'data-variant': 'primary',
      'data-size': 'md',
    });
    expect(buttonStyle('secondary', 'sm')['data-variant']).toBe('secondary');
  });
});

describe('Field', () => {
  it('labels its control and links help and errors to it', () => {
    render(
      <Field label="Mobile number" hint="10 digits" error="Enter a valid mobile number" required>
        <Input name="phone" />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Mobile number' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(input).toHaveAccessibleDescription('10 digits Enter a valid mobile number');
    expect(input).toHaveClass('ui-input');
  });

  it('leaves out what is not given', () => {
    render(
      <Field label="Notes" id="notes" className="extra">
        <Textarea />
      </Field>,
    );
    const textarea = screen.getByRole('textbox', { name: 'Notes' });
    expect(textarea).toHaveAttribute('id', 'notes');
    expect(textarea).not.toHaveAttribute('aria-describedby');
    expect(textarea).not.toHaveAttribute('aria-invalid');
    expect(textarea).toHaveClass('ui-textarea');
  });

  it('works for selects, and controls work outside a Field too', () => {
    render(
      <>
        <Field label="Store" hint="Where you work">
          <Select defaultValue="hyd">
            <option value="hyd">Hyderabad</option>
          </Select>
        </Field>
        <Input aria-label="Loose" />
      </>,
    );
    expect(screen.getByRole('combobox', { name: 'Store' })).toHaveAccessibleDescription(
      'Where you work',
    );
    expect(screen.getByRole('textbox', { name: 'Loose' })).not.toHaveAttribute('id');
  });
});

describe('display components', () => {
  it('Card with a title is a labelled region with actions', () => {
    render(
      <Card title="Stock" actions={<button type="button">More</button>} className="x">
        Body
      </Card>,
    );
    expect(screen.getByRole('region', { name: 'Stock' })).toHaveClass('ui-card', 'x');
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
  });

  it('Card without a title is a plain panel', () => {
    const { container } = render(<Card>Only body</Card>);
    expect(container.querySelector('section')).not.toHaveAttribute('aria-labelledby');
    expect(container.querySelector('header')).toBeNull();
  });

  it('Table is a scrollable, labelled region', () => {
    render(
      <Table label="Stores" className="dense">
        <tbody>
          <tr>
            <td>HYD</td>
          </tr>
        </tbody>
      </Table>,
    );
    const region = screen.getByRole('region', { name: 'Stores' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('table', { name: 'Stores' })).toHaveClass('ui-table', 'dense');
  });

  it('Badge carries a tone', () => {
    render(
      <>
        <Badge>Plain</Badge>
        <Badge tone="danger">Out of stock</Badge>
      </>,
    );
    expect(screen.getByText('Plain')).toHaveAttribute('data-tone', 'neutral');
    expect(screen.getByText('Out of stock')).toHaveAttribute('data-tone', 'danger');
  });

  it('Alert announces errors at once and other messages politely', () => {
    render(
      <>
        <Alert tone="danger" title="Could not load" action={<button type="button">Retry</button>}>
          Network down
        </Alert>
        <Alert>Saved</Alert>
      </>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not loadNetwork downRetry');
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', 'info');
  });

  it('Spinner and Skeleton', () => {
    const { container } = render(
      <>
        <Spinner />
        <Spinner label="Saving" size="lg" />
        <Skeleton width="4rem" height="1rem" className="line" />
      </>,
    );
    expect(screen.getByRole('status', { name: 'Loading' })).toHaveAttribute('data-size', 'md');
    expect(screen.getByRole('status', { name: 'Saving' })).toHaveAttribute('data-size', 'lg');
    const skeleton = container.querySelector('.ui-skeleton');
    expect(skeleton).toHaveAttribute('aria-hidden', 'true');
    expect((skeleton as HTMLElement).style.width).toBe('4rem');
  });

  it('PageHeader has the page heading, with optional description and actions', () => {
    const { rerender } = render(
      <PageHeader title="Dashboard" description="All stores" actions={<button>Export</button>} />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('All stores')).toBeInTheDocument();
    rerender(<PageHeader title="Plain" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('.ui-page-header__description')).toBeNull();
  });

  it('EmptyState', () => {
    const { rerender } = render(
      <EmptyState
        title="No stores yet"
        description="Add your first store"
        icon={<Icon name="store" />}
        action={<button>Add store</button>}
      />,
    );
    expect(screen.getByText('No stores yet')).toBeInTheDocument();
    expect(screen.getByText('Add your first store')).toBeInTheDocument();
    expect(document.querySelector('.ui-empty__icon')).not.toBeNull();
    rerender(<EmptyState title="Nothing" />);
    expect(document.querySelector('.ui-empty__icon')).toBeNull();
    expect(document.querySelector('.ui-empty__description')).toBeNull();
  });

  it('VisuallyHidden keeps text for screen readers', () => {
    render(<VisuallyHidden>3 unread</VisuallyHidden>);
    expect(screen.getByText('3 unread')).toHaveClass('ui-visually-hidden');
  });
});

describe('Icon', () => {
  it('draws every icon decoratively in the text colour', () => {
    const { container } = render(
      <>
        {ICON_NAMES.map((name) => (
          <Icon key={name} name={name} />
        ))}
        <Icon name="bell" size={16} className="bell" />
      </>,
    );
    const icons = container.querySelectorAll('svg');
    expect(icons).toHaveLength(ICON_NAMES.length + 1);
    for (const icon of icons) {
      expect(icon).toHaveAttribute('aria-hidden', 'true');
      expect(icon).toHaveAttribute('stroke', 'currentColor');
      expect(icon.querySelector('path')?.getAttribute('d')).toBeTruthy();
    }
    expect(container.querySelector('.bell')).toHaveAttribute('width', '16');
  });
});
