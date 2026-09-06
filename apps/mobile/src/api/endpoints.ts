/**
 * Every API path in one place.
 *
 * These are the canonical routes of `@wasel/api` under the `/api/v1` prefix. If
 * the server moves one, it changes here and nowhere else — no screen or hook
 * ever writes a URL.
 */
export const endpoints = {
  auth: {
    login: '/auth/login',
    refresh: '/auth/refresh',
    logout: '/auth/logout',
    me: '/auth/me',
    changePassword: '/auth/change-password',
  },
  profile: {
    self: '/profile',
    avatar: '/profile/avatar',
    /**
     * A colleague's picture. Authenticated like every other route, which is why
     * it can never be an `<img src>`: the bytes are fetched with the bearer
     * token and handed to the DOM as an object URL.
     */
    userAvatar: (id: string) => `/users/${encodeURIComponent(id)}/avatar`,
  },
  attendance: {
    status: '/attendance/status',
    checkIn: '/attendance/check-in',
    checkOut: '/attendance/check-out',
    history: '/attendance/history',
  },
  admin: {
    overview: '/admin/overview',
    users: '/admin/users',
    user: (id: string) => `/admin/users/${encodeURIComponent(id)}`,
    userPassword: (id: string) => `/admin/users/${encodeURIComponent(id)}/password`,
    sites: '/admin/sites',
    site: (id: string) => `/admin/sites/${encodeURIComponent(id)}`,
    organization: '/admin/organization',
    /** Manual attendance entry: browse, record, correct and remove a day. */
    attendanceEntries: '/admin/attendance',
    attendanceEntry: (id: string) => `/admin/attendance/${encodeURIComponent(id)}`,
    report: '/admin/reports/attendance',
    export: '/admin/reports/export',
  },
} as const;
