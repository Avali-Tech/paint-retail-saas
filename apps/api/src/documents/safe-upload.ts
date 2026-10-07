import 'reflect-metadata';
import {
  HttpStatus,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ScannerUnavailableError, VirusScanner } from './clamav.js';
import type { ObjectStorage } from './object-storage.js';
import { uploadRefusal } from './upload-refusals.js';

/** Where uploaded files go and how they are checked; null when uploads are not set up. */
export const DOCUMENT_SERVICES = Symbol('DOCUMENT_SERVICES');
export interface DocumentServices {
  readonly storage: ObjectStorage;
  readonly scanner: VirusScanner;
}

/** The upload services, or 503 when this server has no file storage. */
export function requireUploadServices(services: DocumentServices | null): DocumentServices {
  if (!services) {
    throw new ServiceUnavailableException(
      uploadRefusal(
        HttpStatus.SERVICE_UNAVAILABLE,
        'storage_unavailable',
        'Document storage is not set up on this server',
      ),
    );
  }
  return services;
}

/**
 * Scans an uploaded file with ClamAV, then stores it. Refuses (and stores
 * nothing) if the scanner is down or finds a virus, or if storage fails.
 * Used for documents and for logos alike.
 */
export async function scanAndStore(
  { scanner, storage }: DocumentServices,
  file: { readonly key: string; readonly data: Buffer; readonly contentType: string },
): Promise<void> {
  let result;
  try {
    result = await scanner.scan(file.data);
  } catch (error) {
    throw new ServiceUnavailableException(
      uploadRefusal(
        HttpStatus.SERVICE_UNAVAILABLE,
        'scanner_unavailable',
        `Virus scanning is unavailable, so the file was not saved; try again shortly (${(error as ScannerUnavailableError).message})`,
      ),
    );
  }
  if (!result.clean) {
    throw new UnprocessableEntityException(
      uploadRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'virus_found',
        `This file contains a virus (${result.signature}) and was not saved`,
      ),
    );
  }
  try {
    await storage.put(file.key, file.data, file.contentType);
  } catch (error) {
    throw new ServiceUnavailableException(
      uploadRefusal(
        HttpStatus.SERVICE_UNAVAILABLE,
        'storage_unavailable',
        `Document storage is unavailable, so the file was not saved; try again shortly (${(error as Error).message})`,
      ),
    );
  }
}
