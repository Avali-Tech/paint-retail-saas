import 'reflect-metadata';
import {
  createParamDecorator,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { PlatformAuthService, type Operator } from './platform-auth.service.js';

export interface PlatformRequest {
  headers: { authorization?: string };
  operator?: Operator;
}

/** Lets only signed-in platform operators through; tenant tokens do not work here. */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(@Inject(PlatformAuthService) private readonly platformAuth: PlatformAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PlatformRequest>();
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    const operator = token ? await this.platformAuth.authenticate(token) : null;
    if (!operator) throw new UnauthorizedException('Sign in to the platform console');
    request.operator = operator;
    return true;
  }
}

/** The operator a request was made by; only used behind PlatformGuard. */
export function operatorFromRequest(request: PlatformRequest): Operator {
  if (!request.operator) throw new UnauthorizedException('Sign in to the platform console');
  return request.operator;
}

/** The operator making the request (after PlatformGuard). */
export const CurrentOperator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Operator =>
    operatorFromRequest(context.switchToHttp().getRequest<PlatformRequest>()),
);
