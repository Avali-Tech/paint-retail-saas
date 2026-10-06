import type { DocumentUploadError, DocumentUploadErrorCode } from '@paint/shared';

export type { DocumentUploadErrorCode };

/** The body of a refused upload: the message for people and a `code` for the app. */
export function uploadRefusal(
  statusCode: number,
  code: DocumentUploadErrorCode,
  message: string,
): DocumentUploadError {
  return { statusCode, message, code };
}
