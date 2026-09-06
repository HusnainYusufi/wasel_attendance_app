import { lazy } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { RequireAdmin, RequireAuth, RequireGuest } from '../auth';
import { BareLayout } from './BareLayout';
import { paths } from './paths';
import { RootLayout } from './RootLayout';
import { RouteError } from './RouteError';

/**
 * Route table.
 *
 * Every screen is a default export behind `React.lazy`, so each is its own
 * chunk: the sign-in screen must not pull the admin bundle over a phone
 * connection before the user has even authenticated.
 *
 * ── Seam for the screens agent ──────────────────────────────────────────────
 * Replace the body of the files under `src/routes/screens/`. Keep the default
 * export and the filename; nothing else in the shell needs to change.
 */
const SignInScreen = lazy(() => import('./screens/SignInScreen'));
const HomeScreen = lazy(() => import('./screens/HomeScreen'));
const HistoryScreen = lazy(() => import('./screens/HistoryScreen'));
const AdminScreen = lazy(() => import('./screens/AdminScreen'));
const AdminUsersScreen = lazy(() => import('./screens/AdminUsersScreen'));
const AdminSitesScreen = lazy(() => import('./screens/AdminSitesScreen'));
const AdminExportScreen = lazy(() => import('./screens/AdminExportScreen'));
const NotFoundScreen = lazy(() => import('./screens/NotFoundScreen'));

/**
 * Visual reference for the design system, at `/__kitchen-sink`.
 * The dynamic import lives inside the `import.meta.env.DEV` branch so the whole
 * screen is dead-code-eliminated from a production build rather than merely
 * being unroutable in it.
 */
const devRoutes: RouteObject[] = import.meta.env.DEV
  ? [
      {
        path: paths.kitchenSink,
        Component: lazy(() => import('../dev/KitchenSinkScreen')),
      },
    ]
  : [];

export const routes: RouteObject[] = [
  {
    element: <BareLayout />,
    errorElement: <RouteError />,
    children: [
      {
        element: <RequireGuest />,
        children: [{ path: paths.signIn, element: <SignInScreen /> }],
      },
      ...devRoutes,
      { path: '*', element: <NotFoundScreen /> },
    ],
  },
  {
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      {
        element: <RootLayout />,
        children: [
          { path: paths.home, element: <HomeScreen /> },
          { path: paths.history, element: <HistoryScreen /> },
          {
            element: <RequireAdmin />,
            children: [
              { path: paths.admin, element: <AdminScreen /> },
              { path: paths.adminUsers, element: <AdminUsersScreen /> },
              { path: paths.adminSites, element: <AdminSitesScreen /> },
              { path: paths.adminExport, element: <AdminExportScreen /> },
            ],
          },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
