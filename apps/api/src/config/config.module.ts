import { Global, Module } from '@nestjs/common';
import { loadAppConfig } from './app-config.js';
import { AppConfigService } from './app-config.service.js';
import { loadEnvFiles } from './load-env-files.js';

/**
 * Global so that no feature module has to remember to import it — a module that
 * forgets would otherwise be tempted to read `process.env` directly.
 */
@Global()
@Module({
  providers: [
    {
      provide: AppConfigService,
      useFactory: (): AppConfigService => {
        loadEnvFiles();
        return new AppConfigService(loadAppConfig(process.env));
      },
    },
  ],
  exports: [AppConfigService],
})
export class AppConfigModule {}
