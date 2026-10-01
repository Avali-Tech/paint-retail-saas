import 'reflect-metadata';
import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { ScannerUnavailableError, type VirusScanner } from './clamav.js';
import type { ListDocumentsQuery, UploadFields } from './documents.schemas.js';
import { ALLOWED_FILES_MESSAGE, cleanFileName, detectFileType } from './file-checks.js';
import type { ObjectStorage } from './object-storage.js';
import { requireRecordAccess, type RecordType } from './record-access.js';

const { documents, organizationMembers, users } = schema;

/** Where files go and how they are checked; null when uploads are not set up. */
export const DOCUMENT_SERVICES = Symbol('DOCUMENT_SERVICES');
export interface DocumentServices {
  readonly storage: ObjectStorage;
  readonly scanner: VirusScanner;
}

export interface DocumentView {
  readonly id: string;
  readonly recordType: RecordType;
  readonly recordId: string;
  readonly category: (typeof documents.$inferSelect)['category'];
  readonly fileName: string;
  readonly contentType: string;
  readonly note: string | null;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly uploadedBy: { readonly memberId: string; readonly name: string };
  readonly createdAt: string;
}

export interface UploadedFile {
  readonly fileName: string;
  readonly data: Buffer;
}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(DOCUMENT_SERVICES) private readonly services: DocumentServices | null,
  ) {}

  /** Checks, scans and stores a file, then records it against the record. */
  upload(auth: AuthContext, fields: UploadFields, file: UploadedFile): Promise<DocumentView> {
    const { storage, scanner } = this.configured();
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await requireRecordAccess(tx, auth, fields.recordType, fields.recordId, 'manage');
      if (file.data.length === 0) throw new BadRequestException('The file is empty');
      const type = detectFileType(file.data, file.fileName);
      if (!type) throw new UnsupportedMediaTypeException(ALLOWED_FILES_MESSAGE);
      let result;
      try {
        result = await scanner.scan(file.data);
      } catch (error) {
        throw new ServiceUnavailableException(
          `Virus scanning is unavailable, so the file was not saved; try again shortly (${(error as ScannerUnavailableError).message})`,
        );
      }
      if (!result.clean) {
        throw new UnprocessableEntityException(
          `This file contains a virus (${result.signature}) and was not saved`,
        );
      }
      const id = crypto.randomUUID();
      const storageKey = `${auth.organization.id}/documents/${id}`;
      await storage.put(storageKey, file.data, type.contentType);
      await tx.insert(documents).values({
        id,
        organizationId: auth.organization.id,
        recordType: fields.recordType,
        recordId: fields.recordId,
        category: fields.category,
        fileName: cleanFileName(file.fileName, type),
        contentType: type.contentType,
        sizeBytes: file.data.length,
        sha256: createHash('sha256').update(file.data).digest('hex'),
        storageKey,
        note: fields.note,
        uploadedByMemberId: auth.memberId,
      });
      return this.visible(tx, auth, id, 'manage');
    });
  }

  list(auth: AuthContext, query: ListDocumentsQuery): Promise<DocumentView[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await requireRecordAccess(tx, auth, query.recordType, query.recordId, 'read');
      const rows = await this.rows(tx)
        .where(
          and(
            eq(documents.recordType, query.recordType),
            eq(documents.recordId, query.recordId),
            isNull(documents.deletedAt),
          ),
        )
        .orderBy(desc(documents.createdAt), desc(documents.id));
      return rows.map((row) => this.toView(row));
    });
  }

  /** The file's bytes, for members who can see its record. */
  download(
    auth: AuthContext,
    documentId: string,
  ): Promise<{ document: DocumentView; data: Buffer }> {
    const { storage } = this.configured();
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const document = await this.visible(tx, auth, documentId, 'read');
      const [stored] = await tx
        .select({ storageKey: documents.storageKey })
        .from(documents)
        .where(eq(documents.id, documentId));
      return { document, data: await storage.get(String(stored?.storageKey)) };
    });
  }

  /** Hides the document; the file is kept for the audit trail. */
  remove(auth: AuthContext, documentId: string): Promise<void> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await this.visible(tx, auth, documentId, 'manage');
      await tx
        .update(documents)
        .set({ deletedAt: sql`now()`, deletedByMemberId: auth.memberId })
        .where(eq(documents.id, documentId));
    });
  }

  // Helpers -----------------------------------------------------------------

  private configured(): DocumentServices {
    if (!this.services) {
      throw new ServiceUnavailableException('Document storage is not set up on this server');
    }
    return this.services;
  }

  /** A document that is not deleted and whose record the member can see or change. */
  private async visible(
    tx: Transaction,
    auth: AuthContext,
    documentId: string,
    need: 'read' | 'manage',
  ): Promise<DocumentView> {
    const [row] = await this.rows(tx).where(
      and(eq(documents.id, documentId), isNull(documents.deletedAt)),
    );
    if (!row) throw new NotFoundException('Document not found');
    const document = this.toView(row);
    await requireRecordAccess(tx, auth, document.recordType, document.recordId, need);
    return document;
  }

  private rows(tx: Transaction) {
    return tx
      .select({ document: documents, uploaderName: users.fullName })
      .from(documents)
      .innerJoin(organizationMembers, eq(organizationMembers.id, documents.uploadedByMemberId))
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .$dynamic();
  }

  private toView({
    document,
    uploaderName,
  }: {
    document: typeof documents.$inferSelect;
    uploaderName: string;
  }): DocumentView {
    return {
      id: document.id,
      recordType: document.recordType,
      recordId: document.recordId,
      category: document.category,
      fileName: document.fileName,
      contentType: document.contentType,
      note: document.note,
      sizeBytes: document.sizeBytes,
      sha256: document.sha256,
      uploadedBy: { memberId: document.uploadedByMemberId, name: uploaderName },
      createdAt: document.createdAt.toISOString(),
    };
  }
}
