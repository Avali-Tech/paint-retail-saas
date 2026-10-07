import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { GstRegistrationsService } from './gst-registrations.service.js';
import { TaxController } from './tax.controller.js';
import { TaxService } from './tax.service.js';

@Module({
  controllers: [TaxController],
  providers: [TaxService, GstRegistrationsService],
})
export class TaxModule {}
