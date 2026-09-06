import { Spinner } from '../components/Spinner/Spinner';
import { Logo } from './Logo';
import styles from './Splash.module.css';

export interface SplashProps {
  message?: string;
}

/**
 * Shown while the stored session is restored. Without it the router resolves
 * `unauthenticated` for one frame and an already-signed-in user sees the sign-in
 * screen flash past on every cold start.
 */
export function Splash({ message }: SplashProps) {
  return (
    <div className={styles.splash} role="status" aria-live="polite">
      <Logo size="lg" withText />
      <Spinner size="md" className={styles.spinner} />
      <span className={styles.message}>{message ?? 'Restoring your session…'}</span>
    </div>
  );
}
