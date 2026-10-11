import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/i18n.js';
import { lineTintView } from './test-support/tint-fixtures.js';
import { TintSummary } from './TintSummary.js';

describe('TintSummary', () => {
  it('shows the shade, the base and the formula in the member’s units', () => {
    render(
      <I18nProvider locale="en">
        <TintSummary
          tint={lineTintView({
            shadeCode: 'X 132',
            shadeName: 'Ivory Mist',
            formula: [
              { colorant: 'XY', amount: 12.5, unit: 'ml' },
              { colorant: 'B', amount: 2, unit: 'y' },
            ],
          })}
          base="Apex Pastel Base 4 l"
        />
      </I18nProvider>,
    );
    expect(
      screen.getByText(
        'Tint X 132 · Ivory Mist · Base Apex Pastel Base 4 l · Formula XY 12.5 ml, B 2 Y (1/48 oz)',
      ),
    ).toBeInTheDocument();
  });

  it('leaves out a base and a formula it does not have', () => {
    render(
      <I18nProvider locale="hi">
        <TintSummary tint={lineTintView({ shadeCode: 'X 132' })} base={null} />
      </I18nProvider>,
    );
    expect(screen.getByText('टिंट X 132')).toHaveClass('tint-summary');
  });
});
