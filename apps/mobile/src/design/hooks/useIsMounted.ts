import { useEffect, useRef } from 'react';

/** Guards a late async resolution from setting state on an unmounted tree. */
export function useIsMounted(): () => boolean {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return () => mounted.current;
}
