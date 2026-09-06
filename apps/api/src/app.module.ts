import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClockModule } from './common/clock/clock.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { LoggingModule } from './common/logging/logging.module.js';
import { AppConfigModule } from './config/config.module.js';
import { AppConfigService } from './config/app-config.service.js';
import { HealthModule } from './health/health.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AttendanceModule } from './modules/attendance/attendance.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    ClockModule,
    PrismaModule,
    ThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        throttlers: [{ ttl: config.rateLimit.windowMs, limit: config.rateLimit.max }],
      }),
    }),
    HealthModule,
    // AuthModule is @Global() and registers its own APP_GUARD (JwtAuthGuard) via
    // useExisting, because the guard depends on providers the module owns. Do not
    // also register JwtAuthGuard here — that would construct a second instance and
    // double the per-request database read.
    AuthModule,
    AttendanceModule,
    AdminModule,
  ],
  providers: [
    // Global so that a module author cannot forget it and ship a route that
    // answers a failure with a raw Express stack trace.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
