import { useState } from 'react';
import './brand.css';

/**
 * The business's logo, or the first letter of its app name when it has none (or
 * the picture fails to load). Decorative: the app name is always written beside it.
 * Logos sit on a light plate in dark mode, so dark lettering on a transparent
 * background stays visible.
 */
export function BrandMark({
  appName,
  logoSrc,
  size = 'md',
}: {
  readonly appName: string;
  readonly logoSrc: string | null;
  readonly size?: 'md' | 'lg';
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (logoSrc !== null && failed !== logoSrc) {
    return (
      <span className={`brand-logo brand-logo--${size}`} aria-hidden="true">
        <img
          src={logoSrc}
          alt=""
          decoding="async"
          onError={() => {
            setFailed(logoSrc);
          }}
        />
      </span>
    );
  }
  return (
    <span className={`brand-mark brand-mark--${size}`} aria-hidden="true">
      {appName.slice(0, 1)}
    </span>
  );
}
