import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { PartiesController } from './parties.controller.js';
import { PartiesService } from './parties.service.js';

@Module({
  controllers: [PartiesController],
  providers: [PartiesService],
})
export class PartiesModule {}
