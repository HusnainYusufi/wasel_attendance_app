import { Injectable } from '@nestjs/common';
import { AuditService, type AuditEntry } from '../auth/audit.service.js';
import type { ClientInfo } from '../auth/client-context.js';
import type { AdminAuditAction, AdminAuditEntity } from './admin.constants.js';

export interface AdminAuditEntry {
  organizationId: string;
  /** The administrator who performed the action. Never null on an admin route. */
  actorId: string;
  action: AdminAuditAction;
  entityType: AdminAuditEntity;
  /** The row that was acted on — the *target*, not the actor. */
  entityId: string | null;
  metadata?: Record<string, string | number | boolean>;
  client: ClientInfo;
}

/**
 * Admin-side audit trail.
 *
 * Deliberately a thin adapter over the auth module's {@link AuditService} rather
 * than a second implementation: one writer for `audit_logs` means one decision
 * about the failure policy (never throw — see `AuditService.record`) and no risk
 * of the two drifting on column truncation or metadata shape.
 *
 * The single cast below is the entire cost of that reuse. `AuditEntry.action` is
 * typed as the auth module's own closed union of action strings; the column is a
 * `VarChar(64)` and this module's actions are equally valid values, but widening
 * the shared type means editing the auth module, which this module does not own.
 * Isolating the cast here keeps it to one line under one explanation instead of
 * one per call site.
 */
@Injectable()
export class AdminAuditService {
  constructor(private readonly audit: AuditService) {}

  record(entry: AdminAuditEntry): Promise<void> {
    const { action, ...rest } = entry;
    return this.audit.record({ ...rest, action: action as unknown as AuditEntry['action'] });
  }
}
