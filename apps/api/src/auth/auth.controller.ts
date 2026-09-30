import 'reflect-metadata';
import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { toProfile, type AuthContext, type AuthProfile } from './auth-context.js';
import {
  otpRequestSchema,
  otpVerifySchema,
  passwordLoginSchema,
  signupSchema,
  type OtpRequestInput,
  type OtpVerifyInput,
  type PasswordLoginInput,
  type SignupInput,
} from './auth.schemas.js';
import { AuthService, type SessionGrant } from './auth.service.js';
import { CurrentAuth, Public } from './decorators.js';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** Registers a new business and its owner, and signs the owner in. */
  @Public()
  @Post('signup')
  signup(@Body(new ZodValidationPipe(signupSchema)) body: SignupInput): Promise<SessionGrant> {
    return this.auth.signup(body);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(
    @Body(new ZodValidationPipe(passwordLoginSchema)) body: PasswordLoginInput,
  ): Promise<SessionGrant> {
    return this.auth.loginWithPassword(body);
  }

  @Public()
  @Post('otp/request')
  @HttpCode(202)
  async requestOtp(
    @Body(new ZodValidationPipe(otpRequestSchema)) body: OtpRequestInput,
  ): Promise<{ message: string }> {
    await this.auth.requestOtp(body);
    return { message: 'If this number has an account, a code is on its way.' };
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  verifyOtp(
    @Body(new ZodValidationPipe(otpVerifySchema)) body: OtpVerifyInput,
  ): Promise<SessionGrant> {
    return this.auth.verifyOtp(body);
  }

  /** The signed-in user, their business, role, permissions and stores. */
  @Get('me')
  me(@CurrentAuth() auth: AuthContext): AuthProfile {
    return toProfile(auth);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentAuth() auth: AuthContext): Promise<void> {
    await this.auth.logout(auth.sessionId);
  }
}
