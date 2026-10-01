import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ReorderController } from './reorder.controller.js';
import { ReorderService } from './reorder.service.js';

@Module({
  controllers: [ReorderController],
  providers: [ReorderService],
})
export class ReorderModule {}
