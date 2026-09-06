import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaClient } from './prisma-client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfigService) {
    const { url, poolMax, idleTimeoutMs, connectTimeoutMs } = config.database;

    // Prisma 7 has no `url` in schema.prisma; the connection is supplied here by
    // a driver adapter, which is also the only place the pool can be sized.
    const adapter = new PrismaPg(
      {
        connectionString: url,
        max: poolMax,
        idleTimeoutMillis: idleTimeoutMs,
        connectionTimeoutMillis: connectTimeoutMs,
        // Keep a name on the connection so a DBA can attribute `pg_stat_activity`
        // rows to this service rather than to "node".
        application_name: 'wasel-api',
      },
      {
        // `pg` emits 'error' on the pool for connections dropped while idle. With
        // no listener that is an unhandled 'error' event, which takes the process
        // down for something the next query would have retried through.
        onPoolError: (error) => {
          this.logger.error({ err: error }, 'Postgres pool error');
        },
      },
    );

    // Query-level logging is intentionally absent: Prisma's `query` event carries
    // interpolated parameters, which for `users` means the password hash.
    super({ adapter, log: ['warn', 'error'] });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    // Releases every pooled connection. Without it a test run leaks handles and
    // a redeploy leaves sockets open on the database until they time out.
    await this.$disconnect();
  }

  /**
   * Cheapest possible round-trip to the database, for the readiness probe.
   * Deliberately a real query: a live pool object proves nothing about whether
   * Postgres is still accepting work.
   */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
