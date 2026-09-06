/**
 * Route table. Screens navigate with these constants, never with string
 * literals, so a path change is a single edit and a typo is a type error.
 */
export const paths = {
  signIn: '/sign-in',
  home: '/',
  history: '/history',
  admin: '/admin',
  adminUsers: '/admin/users',
  adminSites: '/admin/sites',
  adminAttendance: '/admin/attendance',
  adminExport: '/admin/export',
  kitchenSink: '/__kitchen-sink',
} as const;

export type AppPath = (typeof paths)[keyof typeof paths];
