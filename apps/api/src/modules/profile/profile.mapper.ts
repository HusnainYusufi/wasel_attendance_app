import type { Prisma } from '@prisma/client';
import type { AvatarSummary, ProfileDto, Role, UserStatus } from '@wasel/contracts';
import { isAvatarMimeType } from './avatar-image.js';

/**
 * Prisma row → contract DTO, and the column selection it is built from.
 *
 * The selection is the load-bearing half, twice over:
 *
 *  * `passwordHash`, `tokenVersion`, `failedLoginAttempts` and `lockedUntil` are
 *    absent by construction, so no query written against it can hand a digest to
 *    a caller or into a log.
 *  * **`avatar.data` is absent too.** That is the entire reason `UserAvatar` is a
 *    separate table: the profile response is fetched on every launch and written
 *    to device storage, and dragging tens of kilobytes of JPEG through it — and
 *    through the connection, and through the JSON serialiser — to render a
 *    24 px circle would undo the schema split.
 */
export const PROFILE_USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  employeeCode: true,
  role: true,
  status: true,
  organizationId: true,
  organization: { select: { name: true, timezone: true } },
  avatar: { select: { mimeType: true, byteSize: true, updatedAt: true } },
} as const satisfies Prisma.UserSelect;

export type ProfileRow = {
  id: string;
  email: string;
  fullName: string;
  employeeCode: string | null;
  role: Role;
  status: UserStatus;
  organizationId: string;
  organization: { name: string; timezone: string };
  avatar: { mimeType: string; byteSize: number; updatedAt: Date } | null;
};

/**
 * The stored avatar as the contract describes it, or `null`.
 *
 * A stored `mimeType` outside the accepted set is reported as *no avatar at
 * all*, not as an avatar of an unknown type. Only this module writes that column
 * and only after sniffing the bytes, so the branch should be unreachable — but
 * "should be unreachable" is exactly the assumption that makes a future data fix
 * or a restored backup start advertising a type the serving endpoint would
 * refuse. Failing closed keeps the client's model and the server's behaviour in
 * agreement.
 */
export function toAvatarSummary(row: ProfileRow['avatar']): AvatarSummary | null {
  if (row === null) return null;
  if (!isAvatarMimeType(row.mimeType)) return null;
  return {
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toProfileDto(row: ProfileRow): ProfileDto {
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
    avatar: toAvatarSummary(row.avatar),
  };
}
