import { JwtService } from '@nestjs/jwt';
import { loadAppConfig } from '../../../config/app-config.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { ClockService } from '../../../common/clock/clock.service.js';
import { TokenService } from '../token.service.js';

/**
 * Configuration built from an explicit environment rather than `process.env`.
 *
 * A unit test that reads the ambient environment passes or fails depending on
 * whether the developer happens to have a populated `.env`, which is the least
 * useful reason for a test to be red.
 */
export function testConfig(overrides: Record<string, string> = {}): AppConfigService {
  return new AppConfigService(
    loadAppConfig({
      NODE_ENV: 'test',
      CORS_ORIGINS: 'http://localhost:5173',
      DATABASE_URL: 'postgresql://wasel:wasel@localhost:5432/wasel_unit',
      JWT_ACCESS_SECRET: 'unit-access-secret-0123456789-abcdefghij',
      JWT_REFRESH_SECRET: 'unit-refresh-secret-0123456789-abcdefghij',
      ...overrides,
    }),
  );
}

/** A clock a test can move, without pulling in the integration harness. */
export class MovableClock extends ClockService {
  constructor(private current: Date) {
    super();
  }

  override now(): Date {
    return new Date(this.current);
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export function testTokenService(
  clock: ClockService,
  overrides: Record<string, string> = {},
): TokenService {
  return new TokenService(new JwtService({}), testConfig(overrides), clock);
}

export const FIXED_NOW = new Date('2026-03-01T09:00:00.000Z');
