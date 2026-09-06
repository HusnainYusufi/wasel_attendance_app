import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AUDIT_ENTITY_USER, type AuditAction } from './auth.constants.js';
import type { ClientInfo } from './client-context.js';

export interface AuditEntry {
  organizationId: string;
  /** Null for an action with no established principal. */
  actorId: string | null;
  action: AuditAction;
  entityType?: string;
  entityId?: string | null;
  /**
   * Structured context for an auditor. Constrained to primitives so that nobody
   * can pass a Prisma row through — which is how a `passwordHash` ends up in a
   * JSON column and, from there, in an export.
   */
  metadata?: Record<string, string | number | boolean>;
  client: ClientInfo;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persists one audit row.
   *
   * Deliberately never throws. An audit write failing is a serious operational
   * problem, but turning it into a 500 on a *successful* login would hand an
   * attacker a way to deny service by making the audit table unwritable, and
   * would mask the outcome the caller actually needs. The failure is logged at
   * `error` instead, where alerting can see it.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          organizationId: entry.organizationId,
          actorId: entry.actorId,
          action: entry.action,
          entityType: entry.entityType ?? AUDIT_ENTITY_USER,
          entityId: entry.entityId ?? entry.actorId,
          metadata: entry.metadata ?? {},
          ipAddress: entry.client.ipAddress,
          userAgent: entry.client.userAgent,
        },
      });
    } catch (error) {
      this.logger.error({ err: error, action: entry.action }, 'Failed to write audit log');
    }
  }
}
