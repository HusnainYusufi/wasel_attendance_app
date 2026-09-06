import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Client } from 'pg';
import { AppConfigService } from '../config/app-config.service.js';

/**
 * A readiness probe that hangs is worse than one that fails: the orchestrator
 * keeps routing traffic to the instance until its own timeout expires.
 */
export const DATABASE_PING_TIMEOUT_MS = 2_000;

/**
 * The readiness probe's own connection to Postgres, outside the application pool.
 *
 * **Why not just `prisma.$queryRaw`.** Sharing the application pool couples the
 * probe to application *load*: when every pooled connection is checked out the
 * probe cannot acquire one, the two-second deadline fires, and readiness answers
 * 503 for a database that is perfectly healthy. The orchestrator then pulls the
 * replica, its traffic lands on the others, they saturate in turn, and the fleet
 * unwinds. That cascade is the failure this class exists to prevent.
 *
 * **Why not "treat a timeout as busy but ready".** That is the other obvious fix
 * and it is worse, because it destroys the probe's only real signal. When
 * Postgres is genuinely gone, `connect()` does not reject promptly — it waits out
 * the connect timeout, which is longer than the probe deadline — so a dead
 * database and a saturated pool produce the *same* timeout. Choosing "ready" for
 * both means a replica that cannot serve a single request stays in rotation
 * forever.
 *
 * One dedicated connection per replica separates the two questions: the pool
 * answers "am I busy", this connection answers "is Postgres reachable", and only
 * the second decides readiness. The cost is exactly one connection per replica,
 * which is bounded and visible in `pg_stat_activity` under its own
 * `application_name`.
 *
 * The residual gap — a wedged application pool with a healthy database reads as
 * ready — is deliberate. A wedged pool is a bug that affects every replica
 * identically, and deregistering all of them turns a degraded service into a
 * total outage with no path back.
 */
@Injectable()
export class DatabaseProbe implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseProbe.name);
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly config: AppConfigService) {}

  /**
   * One `SELECT 1` on the dedicated connection. Rejects only on a real
   * connection or query failure.
   */
  async ping(): Promise<void> {
    // One connection means one query at a time. Overlapping probes — two
    // orchestrator checks, or a check arriving while the last one is still
    // waiting out its deadline — share the in-flight answer rather than queueing
    // on the same socket, which is both faster and the only reading that makes
    // sense: they are asking the same question at the same moment.
    this.inFlight ??= this.runPing().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runPing(): Promise<void> {
    const client = await this.acquire();
    try {
      await client.query('SELECT 1');
    } catch (error) {
      // A failed query means this connection is no longer trustworthy — the
      // server may have closed it — so it is dropped and the next probe redials.
      await this.release();
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.release();
  }

  private async acquire(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<Client> {
    const client = new Client({
      connectionString: this.config.database.url,
      // Bounded by the probe's own deadline: a connect attempt that outlives the
      // probe would leave the next one waiting on a hopeless socket.
      connectionTimeoutMillis: Math.min(
        this.config.database.connectTimeoutMs,
        DATABASE_PING_TIMEOUT_MS,
      ),
      query_timeout: DATABASE_PING_TIMEOUT_MS,
      statement_timeout: DATABASE_PING_TIMEOUT_MS,
      // Names the connection in `pg_stat_activity` so a DBA can tell the probe
      // apart from application traffic.
      application_name: 'wasel-api-probe',
    });

    // `pg` emits 'error' on a connection dropped while idle. With no listener that
    // is an unhandled 'error' event, which takes the whole process down for
    // something the next probe would simply have redialled.
    client.on('error', (error: Error) => {
      this.logger.warn({ err: error }, 'Readiness probe connection dropped');
      this.client = null;
      void client.end().catch(() => undefined);
    });

    await client.connect();
    this.client = client;
    return client;
  }

  private async release(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.end();
    } catch {
      // Closing a connection that is already gone is not a failure worth raising
      // from a shutdown hook.
    }
  }
}
