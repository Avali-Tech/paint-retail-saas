import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import type { DocumentsConfig } from '../config.js';
import { ClamavScanner } from './clamav.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { ObjectStorage } from './object-storage.js';
import { DOCUMENT_SERVICES, type DocumentServices } from './safe-upload.js';

@Module({})
export class DocumentsModule {
  static forRoot(config: DocumentsConfig | null): DynamicModule {
    const services: DocumentServices | null = config && {
      storage: ObjectStorage.fromConfig(config),
      scanner: new ClamavScanner(config.clamav.host, config.clamav.port),
    };
    return {
      module: DocumentsModule,
      // Logos (BrandingModule) are scanned and stored by the same services.
      global: true,
      controllers: [DocumentsController],
      providers: [DocumentsService, { provide: DOCUMENT_SERVICES, useValue: services }],
      exports: [DOCUMENT_SERVICES],
    };
  }
}
