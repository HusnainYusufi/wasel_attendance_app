import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router-dom';
import { createQueryClient } from './api';
import { AuthProvider } from './auth';
import { ThemeProvider, ToastProvider } from './design';
import { router } from './routes';

/**
 * Provider order is load-bearing:
 *
 *  QueryClient → Theme → Toast → Auth → Router
 *
 * `AuthProvider` clears the query cache on sign-out, so it must sit inside
 * `QueryClientProvider`. `ToastProvider` sits above `AuthProvider` so a session
 * expiry can announce itself while the router is mid-redirect.
 */
export function App() {
  // Created once per app instance, in state rather than at module scope, so a
  // Fast Refresh cycle does not strand components on a disposed client.
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <RouterProvider router={router} />
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
