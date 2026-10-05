import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';
import { RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';

@Module({
  controllers: [MembersController, RolesController],
  providers: [MembersService, RolesService],
})
export class MembersModule {}
