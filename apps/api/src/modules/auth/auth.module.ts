import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuditService } from './audit.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { LoginThrottleGuard } from './guards/login-throttle.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

/**
 * Authentication and authorization.
 *
 * **Global** for two reasons. It registers the application-wide guards, so
 * importing it once is what makes every route authenticated by default; and it
 * exports `PasswordService` and `TokenService`, which the admin module needs to
 * create users without re-deriving the argon2 parameters — a second copy of
 * those is a second security policy that will drift.
 *
 * `JwtModule.register({})` intentionally configures no secret: access and refresh
 * tokens are signed with *different* keys, supplied per call by `TokenService`,
 * so there is no module-level default that a forgotten `secret:` option could
 * silently fall back to.
 *
 * The guards are registered here rather than in `AppModule` because they depend
 * on providers this module owns. `useExisting` aliases the singletons that are
 * also exported, so a route that applies `JwtAuthGuard` explicitly shares the
 * instance rather than constructing a second one.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuditService,
    PasswordService,
    SessionService,
    TokenService,
    JwtAuthGuard,
    RolesGuard,
    LoginThrottleGuard,
    // Order matters: authentication must resolve the principal before the roles
    // guard looks for it. Nest runs global guards in registration order.
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useExisting: RolesGuard },
  ],
  exports: [AuthService, PasswordService, TokenService, SessionService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
