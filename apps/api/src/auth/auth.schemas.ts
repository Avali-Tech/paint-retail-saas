import { normalizeEmail, normalizePhone } from '@paint/shared';
import { z } from 'zod';

export const phone = z.string().transform((value, context) => {
  const normalized = normalizePhone(value);
  if (normalized === null) {
    context.addIssue({ code: 'custom', message: 'Enter a valid mobile number' });
    return z.NEVER;
  }
  return normalized;
});

export const email = z.string().transform((value, context) => {
  const normalized = normalizeEmail(value);
  if (normalized === null) {
    context.addIssue({ code: 'custom', message: 'Enter a valid email address' });
    return z.NEVER;
  }
  return normalized;
});

export const password = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128, 'Use at most 128 characters');

export const signupSchema = z
  .object({
    organizationName: z.string().trim().min(2).max(120),
    fullName: z.string().trim().min(2).max(120),
    phone: phone.optional(),
    email: email.optional(),
    password,
  })
  .refine((body) => body.phone !== undefined || body.email !== undefined, {
    path: ['phone'],
    message: 'Enter a mobile number or an email address',
  });
export type SignupInput = z.output<typeof signupSchema>;

export const passwordLoginSchema = z.object({
  /** Mobile number or email address. */
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
  organizationId: z.uuid().optional(),
});
export type PasswordLoginInput = z.output<typeof passwordLoginSchema>;

export const otpRequestSchema = z.object({ phone });
export type OtpRequestInput = z.output<typeof otpRequestSchema>;

export const otpVerifySchema = z.object({
  phone,
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  organizationId: z.uuid().optional(),
});
export type OtpVerifyInput = z.output<typeof otpVerifySchema>;
