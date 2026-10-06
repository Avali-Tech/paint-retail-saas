import type { ReactNode } from 'react';

/** A record's facts as a definition list, leaving out the empty ones. */
export function Facts({ facts }: { readonly facts: readonly [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {facts
        .filter((fact) => fact[1] !== null)
        .map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}
