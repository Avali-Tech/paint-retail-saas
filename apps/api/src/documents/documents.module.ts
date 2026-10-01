import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import type { DocumentsConfig } from '../config.js';
import { ClamavScanner } from './clamav.js';
import { DocumentsController } from './documents.controller.js';
import { DOCUMENT_SERVICES, DocumentsService, type DocumentServices } from './documents.service.js';
import { ObjectStorage } from './object-storage.js';

@Module({})
export class DocumentsModule {
  static forRoot(config: DocumentsConfig | null): DynamicModule {
    const services: DocumentServices | null = config && {
      storage: ObjectStorage.fromConfig(config),
      scanner: new ClamavScanner(config.clamav.host, config.clamav.port),
    };
    return {
      module: DocumentsModule,
      controllers: [DocumentsController],
      providers: [DocumentsService, { provide: DOCUMENT_SERVICES, useValue: services }],
    };
  }
}
