import { Injectable } from '@nestjs/common';
import type {
  AppConfig,
  DatabaseConfig,
  HttpConfig,
  JwtConfig,
  LogConfig,
  RateLimitConfig,
  SecurityConfig,
  SwaggerConfig,
} from './app-config.js';

/**
 * The only sanctioned way to read configuration. Everything is resolved and
 * validated once at boot, so consumers get typed values rather than
 * `process.env.SOMETHING!` strings scattered through the codebase.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: AppConfig) {}

  get all(): AppConfig {
    return this.config;
  }

  get nodeEnv(): AppConfig['nodeEnv'] {
    return this.config.nodeEnv;
  }

  get isProduction(): boolean {
    return this.config.isProduction;
  }

  get isTest(): boolean {
    return this.config.isTest;
  }

  get http(): HttpConfig {
    return this.config.http;
  }

  get database(): DatabaseConfig {
    return this.config.database;
  }

  get jwt(): JwtConfig {
    return this.config.jwt;
  }

  get security(): SecurityConfig {
    return this.config.security;
  }

  get rateLimit(): RateLimitConfig {
    return this.config.rateLimit;
  }

  get log(): LogConfig {
    return this.config.log;
  }

  get swagger(): SwaggerConfig {
    return this.config.swagger;
  }
}
