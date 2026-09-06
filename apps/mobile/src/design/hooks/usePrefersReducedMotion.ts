import { useMediaQuery } from './useMediaQuery';

/**
 * For motion that CSS cannot switch off on its own — a `requestAnimationFrame`
 * loop, a scroll animation, an auto-advancing carousel. Purely decorative CSS
 * animation is already collapsed globally by the reset.
 */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
