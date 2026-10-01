import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { reasonSchema } from '../leads/leads.schemas.js';
import {
  createContractSchema,
  listContractsSchema,
  renewContractSchema,
  updateContractSchema,
  type CreateContractInput,
  type ListContractsQuery,
  type RenewContractInput,
  type UpdateContractInput,
} from './contracts.schemas.js';
import { ContractsService, type ContractPage, type ContractView } from './contracts.service.js';

const id = () => new ParseUUIDPipe();

@Controller('contracts')
export class ContractsController {
  constructor(@Inject(ContractsService) private readonly contracts: ContractsService) {}

  @Post()
  @RequirePermissions('contracts:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createContractSchema)) body: CreateContractInput,
  ): Promise<ContractView> {
    return this.contracts.create(auth, body);
  }

  @Get()
  @RequirePermissions('contracts:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listContractsSchema)) query: ListContractsQuery,
  ): Promise<ContractPage> {
    return this.contracts.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('contracts:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) contractId: string,
  ): Promise<ContractView> {
    return this.contracts.get(auth, contractId);
  }

  @Patch(':id')
  @RequirePermissions('contracts:manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) contractId: string,
    @Body(new ZodValidationPipe(updateContractSchema)) body: UpdateContractInput,
  ): Promise<ContractView> {
    return this.contracts.update(auth, contractId, body);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermissions('contracts:manage')
  activate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) contractId: string,
  ): Promise<ContractView> {
    return this.contracts.activate(auth, contractId);
  }

  @Post(':id/terminate')
  @HttpCode(200)
  @RequirePermissions('contracts:manage')
  terminate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) contractId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string },
  ): Promise<ContractView> {
    return this.contracts.terminate(auth, contractId, body.reason);
  }

  /** Creates the follow-on contract (201) and marks this one renewed. */
  @Post(':id/renew')
  @RequirePermissions('contracts:manage')
  renew(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) contractId: string,
    @Body(new ZodValidationPipe(renewContractSchema)) body: RenewContractInput,
  ): Promise<ContractView> {
    return this.contracts.renew(auth, contractId, body);
  }
}
