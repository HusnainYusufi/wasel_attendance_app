/**
 * Reflector metadata keys for the authentication seam.
 *
 * The guards live in the auth module and the decorators live here, so the keys
 * are namespaced constants rather than bare strings: a typo in one half would
 * otherwise fail open — the route would simply look unannotated.
 */
export const IS_PUBLIC_KEY = 'wasel:auth:public' as const;
export const ROLES_KEY = 'wasel:auth:roles' as const;
