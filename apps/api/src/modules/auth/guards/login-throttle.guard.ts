import { Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { AppConfigService } from '../../../config/app-config.service.js';
import { loginRateLimit } from '../auth.constants.js';

/**
 * A tighter per-IP budget for the credential endpoint than the global one.
 *
 * The global limit is sized for ordinary API traffic; at that rate an attacker
 * gets thousands of password guesses an hour from a single address, which the
 * per-account lockout only partly answers — it does nothing about *spraying* one
 * common password across many accounts, where no single account ever locks.
 *
 * The limit is derived from `RATE_LIMIT_MAX` (see `loginRateLimit`) rather than
 * read from its own environment variable, so there is one dial and no way to
 * tighten the global limit while leaving this one stale.
 */
@Injectable()
export class LoginThrottleGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly config: AppConfigService,
  ) {
    super(options, storage, reflector);
  }

  protected override async handleRequest(request: ThrottlerRequest): Promise<boolean> {
    const { limit, ttl } = loginRateLimit(this.config.rateLimit);
    return super.handleRequest({ ...request, limit, ttl, blockDuration: ttl });
  }

  /**
   * A distinct bucket from the globally registered guard's. Both guards run on
   * this route and the base implementation keys only on class, handler and
   * throttler name — without this prefix they would share a counter and each
   * request would be charged twice.
   */
  protected override generateKey(context: ExecutionContext, suffix: string, name: string): string {
    return super.generateKey(context, `login:${suffix}`, name);
  }
}
