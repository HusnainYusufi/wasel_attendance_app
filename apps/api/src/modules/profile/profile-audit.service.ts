import { Injectable } from '@nestjs/common';
import { AuditService, type AuditEntry } from '../auth/audit.service.js';
import type { ClientInfo } from '../auth/client-context.js';
import type { ProfileAuditAction } from './profile.constants.js';
import { PROFILE_AUDIT_ENTITY } from './profile.constants.js';

export interface ProfileAuditEntry {
  organizationId: string;
  /** The account's owner. On a self-service route the actor *is* the subject. */
  actorId: string;
  action: ProfileAuditAction;
  metadata?: Record<string, string | number | boolean>;
  client: ClientInfo;
}

/**
 * Profile-side audit trail.
 *
 * A thin adapter over the auth module's {@link AuditService} rather than a second
 * implementation, for the same reason `AdminAuditService` is: one writer for
 * `audit_logs` means one failure policy (never throw — an unwritable audit table
 * must not become a 500 on a successful edit) and no chance of two writers
 * drifting on the metadata shape.
 *
 * The single cast below is the whole cost of that reuse. `AuditEntry.action` is
 * typed as the auth module's own closed union; the column is a `VarChar(64)` and
 * this module's actions are equally valid values, but widening the shared type
 * means editing the auth module, which this module does not own. One cast under
 * one explanation beats one per call site.
 *
 * `entityId` is always the actor: self-service has no separate target, and
 * pinning it here stops a caller from filing a row against somebody else's
 * account by accident.
 */
@Injectable()
export class ProfileAuditService {
  constructor(private readonly audit: AuditService) {}

  record(entry: ProfileAuditEntry): Promise<void> {
    const { action, ...rest } = entry;
    return this.audit.record({
      ...rest,
      action: action as unknown as AuditEntry['action'],
      entityType: PROFILE_AUDIT_ENTITY,
      entityId: entry.actorId,
    });
  }
}
