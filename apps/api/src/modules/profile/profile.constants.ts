/**
 * `AuditLog.action` values written by the profile module.
 *
 * Dotted, namespaced and stable, exactly like the auth and admin sets: an
 * auditor filters on these strings, so they must survive a method rename.
 */
export const ProfileAuditAction = {
  /** Name and/or email changed by their owner. */
  PROFILE_UPDATED: 'profile.updated',
  /**
   * The sign-in address moved, written *in addition to* `PROFILE_UPDATED`.
   *
   * Two rows for one request, and the duplication is the point. `profile.updated`
   * answers "what did this person change about themselves?"; this row is the
   * account's *identity timeline*, and it is the one an investigator reaches for
   * after a suspected takeover. Finding it under the generic row would mean a
   * JSON-path predicate over every profile edit the tenant has ever seen, to
   * pick out the handful that moved half of a credential pair.
   */
  EMAIL_CHANGED: 'profile.email_changed',
  /**
   * An email change refused for a wrong current password.
   *
   * The single most interesting row in this module: repeated failures against
   * one account are somebody holding the device but not the password, which is
   * exactly the attack the password step-up exists to stop.
   */
  EMAIL_CHANGE_REJECTED: 'profile.email_change_rejected',
  AVATAR_UPDATED: 'profile.avatar.updated',
  AVATAR_REMOVED: 'profile.avatar.removed',
} as const;
export type ProfileAuditAction = (typeof ProfileAuditAction)[keyof typeof ProfileAuditAction];

/** `AuditLog.entityType` — the Prisma model name, so a row can be resolved. */
export const PROFILE_AUDIT_ENTITY = 'User';
