import { Module } from '@nestjs/common';
import { LoggerModule, type Params } from 'nestjs-pino';
import { AppConfigModule } from '../../config/config.module.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { LOG_DESTINATION, LogDestinationModule, type LogDestination } from './log-destination.js';
import { buildPinoHttpOptions } from './pino-options.js';

@Module({
  imports: [
    LogDestinationModule,
    LoggerModule.forRootAsync({
      imports: [AppConfigModule, LogDestinationModule],
      inject: [AppConfigService, LOG_DESTINATION],
      useFactory: (config: AppConfigService, destination: LogDestination): Params => {
        const options = buildPinoHttpOptions(config);
        return { pinoHttp: destination ? [options, destination] : options };
      },
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
