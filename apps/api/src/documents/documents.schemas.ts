import { schema } from '@paint/db';
import { z } from 'zod';
import { RECORD_TYPES } from './record-access.js';

export const DOCUMENT_CATEGORIES = schema.documentCategory.enumValues;

const record = { recordType: z.enum(RECORD_TYPES), recordId: z.uuid() };

/** The form fields sent with an upload. */
export const uploadFieldsSchema = z.object({ ...record, category: z.enum(DOCUMENT_CATEGORIES) });
export type UploadFields = z.output<typeof uploadFieldsSchema>;

export const listDocumentsSchema = z.object(record);
export type ListDocumentsQuery = z.output<typeof listDocumentsSchema>;
