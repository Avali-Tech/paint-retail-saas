import { schema } from '@paint/db';
import { z } from 'zod';
import { RECORD_TYPES } from './record-access.js';

export const DOCUMENT_CATEGORIES = schema.documentCategory.enumValues;

const record = { recordType: z.enum(RECORD_TYPES), recordId: z.uuid() };

/** The form fields sent with an upload. */
export const uploadFieldsSchema = z.object({
  ...record,
  category: z.enum(DOCUMENT_CATEGORIES),
  /** What the file shows, e.g. "North wall before repair". */
  note: z.string().trim().min(1).max(500).optional(),
});
export type UploadFields = z.output<typeof uploadFieldsSchema>;

/** A record's documents. */
export const listDocumentsSchema = z.object(record);
export type ListDocumentsQuery = z.output<typeof listDocumentsSchema>;

const day = z.iso.date();

/** Documents across every record the member can see, newest first. */
export const browseDocumentsSchema = z
  .object({
    recordType: z.enum(RECORD_TYPES).optional(),
    category: z.enum(DOCUMENT_CATEGORIES).optional(),
    /** Who uploaded it: a member id or "me". */
    uploadedBy: z.union([z.uuid(), z.literal('me')]).optional(),
    /** India-time days, inclusive, of when it was uploaded. */
    from: day.optional(),
    to: day.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    path: ['to'],
    message: 'The “to” date cannot be before the “from” date',
  });
export type BrowseDocumentsQuery = z.output<typeof browseDocumentsSchema>;
