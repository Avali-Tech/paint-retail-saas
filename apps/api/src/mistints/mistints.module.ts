import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { MistintsController } from './mistints.controller.js';
import { MistintsService } from './mistints.service.js';

@Module({
  controllers: [MistintsController],
  providers: [MistintsService],
})
export class MistintsModule {}
