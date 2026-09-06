import type {
  AttendanceHistoryQuery,
  AttendanceReportQuery,
  ListAttendanceEntriesQuery,
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

  profile: {
    all: ['profile'] as const,
    self: () => [...queryKeys.profile.all, 'self'] as const,
    /**
     * Keyed on `updatedAt` as well as the user.
     *
     * That is what makes a replaced picture appear immediately: the new profile
     * carries a new timestamp, which is a different key, so the old blob is not
     * reused. Without it the cache would happily serve the previous image until
     * its `staleTime` expired — the classic "I changed my photo and nothing
     * happened" bug.
     */
    avatar: (userId: string, updatedAt: string) =>
      [...queryKeys.profile.all, 'avatar', userId, updatedAt] as const,
  },

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
    attendanceEntries: (query: Partial<ListAttendanceEntriesQuery>) =>
      [...queryKeys.admin.all, 'attendance-entries', query] as const,
  },
} as const;
