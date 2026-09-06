import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  authUserSchema,
  changePasswordRequestSchema,
  loginRequestSchema,
  loginResponseSchema,
  logoutRequestSchema,
  refreshRequestSchema,
  refreshResponseSchema,
  type AuthUser,
  type ChangePasswordRequest,
  type LoginRequest,
  type LoginResponse,
  type LogoutRequest,
  type RefreshRequest,
  type RefreshResponse,
} from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Public } from '../../common/auth/public.decorator.js';
import {
  ApiErrorResponses,
  ApiZodBody,
  ApiZodResponse,
} from '../../common/openapi/zod-api.decorators.js';
import { ZodBody } from '../../common/pipes/zod-param.decorators.js';
import { AuthService } from './auth.service.js';
import { ClientContext, type ClientInfo } from './client-context.js';
import { LoginThrottleGuard } from './guards/login-throttle.guard.js';

/**
 * Logging out with no body at all is legitimate — a client that has already lost
 * its refresh token still wants the audit entry — but Express 5 leaves
 * `req.body` undefined for a request that carries none, which the contract schema
 * rejects. Tolerating that here keeps the shape the contract defines while not
 * answering 400 to a perfectly reasonable request.
 */
const logoutBodySchema = logoutRequestSchema.optional().default({});

/**
 * Thin by design: validate, delegate, return. Every decision that could be got
 * wrong — ordering of the credential checks, rotation, revocation — lives in the
 * service, where it is unit-testable without an HTTP server.
 *
 * The three mutating, no-content routes answer `204`: `@wasel/contracts` declares
 * no response shape for them, and inventing one locally would be exactly the
 * parallel DTO the contract package exists to prevent.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @UseGuards(LoginThrottleGuard)
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Exchange credentials for a token pair',
    description:
      'Rate limited more tightly than the rest of the API. An unknown address and ' +
      'a wrong password are indistinguishable in status, code, body and timing.',
  })
  @ApiZodBody(loginRequestSchema)
  @ApiZodResponse(200, loginResponseSchema, 'Authenticated')
  @ApiErrorResponses(400, 401, 403, 429)
  login(
    @ZodBody(loginRequestSchema) body: LoginRequest,
    @ClientContext() client: ClientInfo,
  ): Promise<LoginResponse> {
    return this.auth.login(body, client);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Rotate a refresh token',
    description:
      'Each refresh token may be exchanged once. Presenting a spent token is ' +
      'treated as theft and revokes every token in its rotation family.',
  })
  @ApiZodBody(refreshRequestSchema)
  @ApiZodResponse(200, refreshResponseSchema, 'Rotated')
  @ApiErrorResponses(400, 401, 403)
  refresh(
    @ZodBody(refreshRequestSchema) body: RefreshRequest,
    @ClientContext() client: ClientInfo,
  ): Promise<RefreshResponse> {
    return this.auth.refresh(body, client);
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Sign this device out',
    description: 'Revokes the rotation family of the presented refresh token.',
  })
  @ApiZodBody(logoutRequestSchema)
  @ApiErrorResponses(400, 401, 403)
  logout(
    @CurrentUser() auth: AuthContext,
    @ZodBody(logoutBodySchema) body: LogoutRequest,
    @ClientContext() client: ClientInfo,
  ): Promise<void> {
    return this.auth.logout(auth, body, client);
  }

  @Post('logout-all')
  @HttpCode(204)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Sign every device out',
    description:
      'Revokes all sessions and bumps `tokenVersion`, which invalidates access ' +
      'tokens already in flight.',
  })
  @ApiErrorResponses(401, 403)
  logoutAll(@CurrentUser() auth: AuthContext, @ClientContext() client: ClientInfo): Promise<void> {
    return this.auth.logoutAll(auth, client);
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'The authenticated principal' })
  @ApiZodResponse(200, authUserSchema, 'The current user')
  @ApiErrorResponses(401, 403)
  me(@CurrentUser() auth: AuthContext): Promise<AuthUser> {
    return this.auth.currentUser(auth);
  }

  @Post('change-password')
  @HttpCode(204)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Change the current password',
    description: 'Invalidates every token issued before the change.',
  })
  @ApiZodBody(changePasswordRequestSchema)
  @ApiErrorResponses(400, 401, 403)
  changePassword(
    @CurrentUser() auth: AuthContext,
    @ZodBody(changePasswordRequestSchema) body: ChangePasswordRequest,
    @ClientContext() client: ClientInfo,
  ): Promise<void> {
    return this.auth.changePassword(auth, body, client);
  }
}
