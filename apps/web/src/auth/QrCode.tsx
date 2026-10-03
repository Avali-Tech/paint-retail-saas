import { useMemo } from 'react';
import { encode } from 'uqr';

/** The quiet zone scanners need around a QR code, in modules (the QR specification asks for 4). */
const QUIET_ZONE = 4;

/** One SVG path drawing every dark module of a QR code. */
export function qrPath(value: string): { readonly size: number; readonly path: string } {
  const { size, data } = encode(value, { ecc: 'M', border: QUIET_ZONE });
  const path = data
    .flatMap((row, y) =>
      row.flatMap((dark, x) => (dark ? [`M${String(x)} ${String(y)}h1v1h-1z`] : [])),
    )
    .join('');
  return { size, path };
}

/**
 * A QR code drawn as SVG. Always dark on light, whatever the theme, because
 * not every scanner reads inverted codes (the colours come from the neutral ramp).
 */
export function QrCode({ value, label }: { readonly value: string; readonly label: string }) {
  const { size, path } = useMemo(() => qrPath(value), [value]);
  return (
    <svg
      className="qr-code"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      shapeRendering="crispEdges"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}
