import { z } from 'zod';
import { emailSchema, fullNameSchema, passwordSchema, uuidSchema } from './common.js';
import { Role, UserStatus } from './constants.js';

// --- Requests --------------------------------------------------------------

export const loginRequestSchema = z.object({
  email: emailSchema,
  /**
   * Deliberately NOT `passwordSchema`. Applying the creation policy to login
   * would leak which stored passwords predate the policy, and would reject
   * legitimate older credentials. Login only bounds the length.
   */
  password: z.string().min(1, 'Password is required').max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const logoutRequestSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;

export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required').max(128),
    newPassword: passwordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'New password must be different from the current password',
    path: ['newPassword'],
  });
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

// --- Responses -------------------------------------------------------------

export const authUserSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  fullName: z.string(),
  employeeCode: z.string().nullable(),
  role: z.enum([Role.ADMIN, Role.MEMBER]),
  status: z.enum([UserStatus.ACTIVE, UserStatus.SUSPENDED]),
  organizationId: uuidSchema,
  organizationName: z.string(),
  /** Organization IANA timezone — the client renders every timestamp in it. */
  timezone: z.string(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const authTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Access-token lifetime in seconds; the client refreshes ahead of this. */
  expiresIn: z.number().int().positive(),
  tokenType: z.literal('Bearer'),
});
export type AuthTokens = z.infer<typeof authTokensSchema>;

export const loginResponseSchema = z.object({
  user: authUserSchema,
  tokens: authTokensSchema,
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const refreshResponseSchema = z.object({ tokens: authTokensSchema });
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

/** Claims carried by the access token. */
export interface AccessTokenClaims {
  sub: string;
  org: string;
  role: Role;
  /** Must match `User.tokenVersion`, else the token was revoked. */
  tv: number;
  iat: number;
  exp: number;
}

/** Claims carried by the refresh token. */
export interface RefreshTokenClaims {
  sub: string;
  /** Rotation-chain identifier, for reuse detection. */
  fam: string;
  /** Session row id this token was issued against. */
  sid: string;
  iat: number;
  exp: number;
}
