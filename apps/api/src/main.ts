import { NestFactory } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp, installShutdownDeadline } from './bootstrap.js';
import { EnvValidationError, loadAppConfig } from './config/app-config.js';
import { loadEnvFiles } from './config/load-env-files.js';

async function bootstrap(): Promise<void> {
  loadEnvFiles();

  // Validated before Nest starts so a misconfigured deployment prints one clean
  // list of problems instead of a dependency-injection stack trace.
  const config = loadAppConfig(process.env);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Buffered until the pino logger is installed, so early boot lines are
    // structured like every other line rather than falling back to console.
    bufferLogs: true,
    // Destroys idle and keep-alive sockets when the server closes. Without it a
    // browser holding an idle keep-alive connection is enough to keep the server
    // open for the whole orchestrator grace period, and the shutdown that was
    // meant to be graceful ends in a SIGKILL.
    forceCloseConnections: true,
  });

  // Armed before `listen`, so a signal arriving during a slow start is still
  // bounded.
  installShutdownDeadline();

  const { swaggerPath } = await configureApp(app);

  await app.listen(config.http.port, config.http.host);

  const logger = await app.resolve(PinoLogger);
  logger.setContext('Bootstrap');
  logger.info(
    {
      port: config.http.port,
      env: config.nodeEnv,
      docs: swaggerPath ?? 'disabled',
    },
    'Wasel Attendance API is listening',
  );
}

bootstrap().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  process.stderr.write(
    `Failed to start: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
