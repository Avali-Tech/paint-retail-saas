import 'reflect-metadata';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Inject,
  PayloadTooLargeException,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type {} from '@fastify/multipart';
import type { OrganizationIdentity } from '@paint/shared';
import type { FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { uploadRefusal } from '../documents/upload-refusals.js';
import { slugSchema } from './branding.schemas.js';
import { IdentityService } from './identity.service.js';
import { MAX_LOGO_BYTES } from './logo-checks.js';

/** The business's sign-in link name and logo. */
@Controller('organization')
export class IdentityController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  /** For any signed-in member: the app shows the logo and the sign-in link. */
  @Get('identity')
  get(@CurrentAuth() auth: AuthContext): Promise<OrganizationIdentity> {
    return this.identity.get(auth);
  }

  @Put('slug')
  @RequirePermissions('organization:manage')
  setSlug(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(slugSchema)) body: { slug: string },
  ): Promise<OrganizationIdentity> {
    return this.identity.setSlug(auth, body.slug);
  }

  /** multipart/form-data with one file: a PNG, JPEG or WebP of at most 1 MB. */
  @Post('logo')
  @RequirePermissions('organization:manage')
  async uploadLogo(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
  ): Promise<OrganizationIdentity> {
    if (!request.isMultipart()) {
      throw new BadRequestException('Send the logo as multipart/form-data');
    }
    let upload: { data: Buffer; truncated: boolean } | null = null;
    try {
      const file = await request.file({
        limits: { fileSize: MAX_LOGO_BYTES, files: 1 },
        throwFileSizeLimit: false,
      });
      if (file) upload = { data: await file.toBuffer(), truncated: file.file.truncated };
    } catch (error) {
      throw new BadRequestException(`The upload could not be read: ${(error as Error).message}`);
    }
    if (!upload) throw new BadRequestException('Attach the logo to upload');
    if (upload.truncated) {
      throw new PayloadTooLargeException(
        uploadRefusal(HttpStatus.PAYLOAD_TOO_LARGE, 'too_large', 'Logos can be at most 1 MB'),
      );
    }
    return this.identity.uploadLogo(auth, upload.data);
  }

  @Delete('logo')
  @RequirePermissions('organization:manage')
  removeLogo(@CurrentAuth() auth: AuthContext): Promise<OrganizationIdentity> {
    return this.identity.removeLogo(auth);
  }
}
