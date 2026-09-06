import type { Prisma } from '@prisma/client';
import type { AuthUser, Role, UserStatus } from '@wasel/contracts';

/**
 * The columns `AuthUser` is built from — and, just as importantly, the ones it is
 * not. `passwordHash` is absent by construction, so no query written against this
 * selection can hand a digest to a caller or a logger.
 */
export const AUTH_USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  employeeCode: true,
  role: true,
  status: true,
  organizationId: true,
  organization: { select: { name: true, timezone: true } },
} as const satisfies Prisma.UserSelect;

export type AuthUserRow = {
  id: string;
  email: string;
  fullName: string;
  employeeCode: string | null;
  role: Role;
  status: UserStatus;
  organizationId: string;
  organization: { name: string; timezone: string };
};

/** Prisma row → contract DTO. The only shape that leaves this module. */
export function toAuthUser(row: AuthUserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    employeeCode: row.employeeCode,
    role: row.role,
    status: row.status,
    organizationId: row.organizationId,
    organizationName: row.organization.name,
    timezone: row.organization.timezone,
  };
}
