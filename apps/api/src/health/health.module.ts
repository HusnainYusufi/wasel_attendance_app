import { Module } from '@nestjs/common';
import { DatabaseProbe } from './database-probe.js';
import { HealthController } from './health.controller.js';

@Module({ controllers: [HealthController], providers: [DatabaseProbe] })
export class HealthModule {}
