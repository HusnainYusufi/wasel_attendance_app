import { Module } from '@nestjs/common';
import { AuditService } from '../auth/audit.service.js';
import { ProfileAuditService } from './profile-audit.service.js';
import { ProfileAvatarService } from './profile-avatar.service.js';
import { ProfileController } from './profile.controller.js';
import { ProfileService } from './profile.service.js';
import { UserAvatarController } from './user-avatar.controller.js';

/**
 * Self-service account management: your own name, sign-in address and picture.
 *
 * It imports nothing. `PrismaModule`, `ClockModule` and `AuthModule` are all
 * `@Global()`, so `PasswordService` — which this module reuses to verify the
 * step-up credential rather than making a second argon2 call site — resolves
 * without a local import. Two hashers with different parameters would be two
 * security policies, and the weaker one wins silently.
 *
 * Password *changes* are not here: `POST /auth/change-password` already exists,
 * already revokes every session, and already has the client flow built around
 * it. A second endpoint doing the same thing is a second place for the
 * revocation rule to be got wrong.
 *
 * `AuditService` is listed as a provider only because `AuthModule` does not
 * export it. That gives this module its own instance of the *same class*, which
 * is safe precisely because the service is stateless: one implementation, one
 * failure policy, one table. This mirrors `AdminModule`, which does the same for
 * the same reason.
 */
@Module({
  controllers: [ProfileController, UserAvatarController],
  providers: [AuditService, ProfileAuditService, ProfileService, ProfileAvatarService],
})
export class ProfileModule {}
