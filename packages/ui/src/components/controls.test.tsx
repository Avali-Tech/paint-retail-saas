import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox, Pagination } from './Controls.js';

const range = (from: number, to: number, total: number) =>
  `${String(from)}–${String(to)} of ${String(total)}`;

describe('Checkbox', () => {
  it('is a labelled native checkbox', async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Show inactive" className="extra" onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Show inactive' });
    await userEvent.click(box);
    expect(box).toBeChecked();
    expect(onChange).toHaveBeenCalledOnce();
    expect(box.closest('label')).toHaveClass('ui-checkbox', 'extra');
  });
});

describe('Pagination', () => {
  it('is hidden when everything fits on one page', () => {
    const { container } = render(
      <Pagination
        offset={0}
        limit={50}
        total={10}
        onChange={vi.fn()}
        label="Pages"
        range={range}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('moves between pages and stops at either end', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Pagination
        offset={0}
        limit={50}
        total={120}
        onChange={onChange}
        label="Pages"
        range={range}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    expect(nav).toHaveTextContent('1–50 of 120');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onChange).toHaveBeenLastCalledWith(50);

    rerender(
      <Pagination
        offset={100}
        limit={50}
        total={120}
        onChange={onChange}
        label="Pages"
        range={range}
        previousLabel="Back"
        nextLabel="More"
      />,
    );
    expect(nav).toHaveTextContent('101–120 of 120');
    expect(screen.getByRole('button', { name: 'More' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onChange).toHaveBeenLastCalledWith(50);

    // A page past the end (after filtering) can still go back.
    rerender(
      <Pagination
        offset={50}
        limit={50}
        total={0}
        onChange={onChange}
        label="Pages"
        range={range}
      />,
    );
    expect(nav).toHaveTextContent('0–0 of 0');
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it('follows the list rather than the total when it says whether more rows follow', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Pagination
        offset={0}
        limit={50}
        total={50}
        hasMore
        onChange={onChange}
        label="Pages"
        range={range}
      />,
    );
    // The count stopped at the cap, but the list has more: Next still works.
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onChange).toHaveBeenLastCalledWith(50);

    rerender(
      <Pagination
        offset={50}
        limit={50}
        total={120}
        hasMore={false}
        onChange={onChange}
        label="Pages"
        range={range}
      />,
    );
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});
