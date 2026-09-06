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
    report: '/admin/reports/attendance',
    export: '/admin/reports/export',
  },
} as const;
