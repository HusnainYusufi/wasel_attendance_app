import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { profileApi, queryKeys } from '../../api';

/**
 * The caller's own profile.
 *
 * Distinct from `useAuth().user`, which is the `AuthUser` the session was
 * established with and is what the router and the guards read. This adds the
 * avatar metadata and is what the account surface renders — keeping them apart
 * means an avatar upload never has to invalidate the session object the whole
 * app depends on.
 */
export function useProfile() {
  return useQuery({
    queryKey: queryKeys.profile.self(),
    queryFn: ({ signal }) => profileApi.get(signal),
    staleTime: 60_000,
  });
}

/**
 * A displayable URL for a user's avatar, or `null`.
 *
 * The route is authenticated, so an `<img src>` pointed straight at it would
 * send no bearer token and render a broken image. The bytes are fetched through
 * the API client instead and handed to the DOM as an object URL.
 *
 * The URL is created in an effect and revoked in its cleanup, so a screen that
 * mounts and unmounts repeatedly — which is every navigation — does not leak a
 * blob per visit. The query itself is keyed on `updatedAt`, so replacing the
 * picture produces a different key and the previous blob is never reused.
 *
 * `retry: false` because the interesting failure is a 404 (no picture set, or
 * another tenant's user), and retrying a 404 twice just delays falling back to
 * initials.
 */
export function useAvatarObjectUrl(
  userId: string | undefined,
  updatedAt: string | null | undefined,
): string | null {
  const enabled = Boolean(userId) && Boolean(updatedAt);

  const { data } = useQuery({
    queryKey: queryKeys.profile.avatar(userId ?? '', updatedAt ?? ''),
    queryFn: ({ signal }) => profileApi.avatarBlob(userId as string, signal),
    enabled,
    // The key already carries the version, so a cached entry can never be stale:
    // a new picture is a new key rather than a refetch of this one.
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  });

  const blob = data?.blob ?? null;
  const [url, setUrl] = useState<string | null>(null);

  /*
   * eslint-disable-next-line is deliberate, and this is the carve-out the rule's
   * own guidance describes: an object URL is an external resource whose lifetime
   * this component owns. It must be created *after* commit so that the matching
   * cleanup can revoke it, and there is no way to render it without holding it
   * in state.
   *
   * Creating it during render (a `useMemo`) is the obvious alternative and is
   * wrong: StrictMode's deliberate mount → unmount → mount would run the
   * cleanup, revoke the URL, and then re-run the effect with the same
   * already-revoked string — a permanently broken image, in development only,
   * which is the worst place to hide one. The cost here is one extra render per
   * *image actually loaded*, not per render.
   */
  useEffect(() => {
    if (!blob) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  return url;
}
