import type { DocumentUploadErrorCode, LogoUploadErrorCode } from '@paint/shared';

export type { DocumentUploadErrorCode };

/** The body of a refused upload (a document or a logo): the message for people and a `code` for the app. */
export function uploadRefusal<Code extends LogoUploadErrorCode>(
  statusCode: number,
  code: Code,
  message: string,
): { readonly statusCode: number; readonly message: string; readonly code: Code } {
  return { statusCode, message, code };
}
