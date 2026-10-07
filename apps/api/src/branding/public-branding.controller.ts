import 'reflect-metadata';
import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { PublicBranding } from '@paint/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../auth/decorators.js';
import { PublicBrandingService } from './public-branding.service.js';

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** A business's branded sign-in page, before anyone signs in (`/sign-in?b=<slug>`). */
@Public()
@Controller('public/branding')
export class PublicBrandingController {
  constructor(@Inject(PublicBrandingService) private readonly branding: PublicBrandingService) {}

  @Get(':slug')
  async find(
    @Param('slug') slug: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PublicBranding> {
    const found = await this.branding.find(slug);
    void reply.header('cache-control', 'public, max-age=60');
    return found;
  }

  /**
   * The logo, shown inline. Its address changes with every new logo, so it may be
   * cached for good; the ETag lets a browser check it without downloading it again.
   * A picture never runs as a page here: nosniff, and a CSP that allows nothing.
   */
  @Get(':slug/logo/:version')
  async logo(
    @Param('slug') slug: string,
    @Param('version') version: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const logo = await this.branding.logo(slug, version);
    const etag = `"${logo.sha256}"`;
    void reply
      .header('etag', etag)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox");
    if (request.headers['if-none-match'] === etag) {
      await reply.code(304).send();
      return;
    }
    await reply
      .header('content-type', logo.contentType)
      .header(
        'content-disposition',
        `inline; filename="logo.${String(EXTENSIONS[logo.contentType])}"`,
      )
      .send(await this.branding.logoBytes(logo));
  }
}
