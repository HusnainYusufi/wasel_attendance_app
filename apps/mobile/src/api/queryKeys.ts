import type {
  AttendanceHistoryQuery,
  AttendanceReportQuery,
  ListUsersQuery,
} from '@wasel/contracts';

/**
 * Query-key factory.
 *
 * Keys are built here so invalidation can be coarse and still correct: a punch
 * invalidates `queryKeys.attendance.all` and every status/history entry under it
 * goes stale, without any screen having to know what else is cached.
 */
export const queryKeys = {
  session: ['session'] as const,

  attendance: {
    all: ['attendance'] as const,
    status: () => [...queryKeys.attendance.all, 'status'] as const,
    history: (query: Partial<AttendanceHistoryQuery>) =>
      [...queryKeys.attendance.all, 'history', query] as const,
  },

  admin: {
    all: ['admin'] as const,
    overview: () => [...queryKeys.admin.all, 'overview'] as const,
    users: (query: Partial<ListUsersQuery>) => [...queryKeys.admin.all, 'users', query] as const,
    sites: () => [...queryKeys.admin.all, 'sites'] as const,
    organization: () => [...queryKeys.admin.all, 'organization'] as const,
    report: (query: Partial<AttendanceReportQuery>) =>
      [...queryKeys.admin.all, 'report', query] as const,
  },
} as const;
