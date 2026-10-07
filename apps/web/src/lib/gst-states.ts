import { gstStateName } from '@paint/shared';

/** "36" -> "36 · Telangana"; a code we do not know shows as itself. */
export function stateLabel(code: string): string {
  return [code, gstStateName(code)].filter(Boolean).join(' · ');
}
