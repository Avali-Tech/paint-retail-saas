import 'reflect-metadata';
import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type {} from '@fastify/multipart';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  browseDocumentsSchema,
  listDocumentsSchema,
  uploadFieldsSchema,
} from './documents.schemas.js';
import {
  DocumentsService,
  type DocumentPage,
  type DocumentView,
  type UploadedFile,
} from './documents.service.js';
import { attachmentHeader, MAX_DOCUMENT_BYTES } from './file-checks.js';
import { uploadRefusal } from './upload-refusals.js';

// Permissions follow the record a document is attached to; the service checks them.
@Controller('documents')
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly documents: DocumentsService) {}

  /** multipart/form-data with fields recordType, recordId, category and one file. */
  @Post()
  async upload(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
  ): Promise<DocumentView> {
    if (!request.isMultipart()) {
      throw new BadRequestException('Send the file as multipart/form-data');
    }
    const fields: Record<string, string> = {};
    const files: (UploadedFile & { truncated: boolean })[] = [];
    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          fields[part.fieldname] = String(part.value);
        } else {
          const data = await part.toBuffer();
          files.push({ fileName: part.filename, data, truncated: part.file.truncated });
        }
      }
    } catch (error) {
      // A second file, too many fields or a malformed body.
      throw new BadRequestException(`The upload could not be read: ${(error as Error).message}`);
    }
    const [file] = files;
    if (file?.truncated) {
      throw new PayloadTooLargeException(
        uploadRefusal(
          HttpStatus.PAYLOAD_TOO_LARGE,
          'too_large',
          `Files can be at most ${String(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB`,
        ),
      );
    }
    const parsed = new ZodValidationPipe(uploadFieldsSchema).transform(fields);
    if (!file) throw new BadRequestException('Attach the file to upload');
    return this.documents.upload(auth, parsed, { fileName: file.fileName, data: file.data });
  }

  /**
   * With recordType and recordId, that record's documents (a list). Without a
   * record, documents on every record the member can see (a page), filtered.
   */
  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query() query: Record<string, unknown>,
  ): Promise<DocumentView[] | DocumentPage> {
    if (query.recordId !== undefined) {
      return this.documents.list(auth, new ZodValidationPipe(listDocumentsSchema).transform(query));
    }
    return this.documents.browse(
      auth,
      new ZodValidationPipe(browseDocumentsSchema).transform(query),
    );
  }

  @Get(':id/download')
  async download(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) documentId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const { document, data } = await this.documents.download(auth, documentId);
    // Always a download, never shown inline, so an uploaded file cannot run in our site.
    void reply
      .header('content-type', document.contentType)
      .header('content-disposition', attachmentHeader(document.fileName))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store');
    return data;
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) documentId: string,
  ): Promise<void> {
    return this.documents.remove(auth, documentId);
  }
}
