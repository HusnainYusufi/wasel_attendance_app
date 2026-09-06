import type { ReactNode } from 'react';
import { Card, Skeleton, cx } from '../design';
import styles from './StatTile.module.css';

export type StatTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface StatTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatTone;
  loading?: boolean;
}

/**
 * One dashboard figure.
 *
 * The number leads and the label follows, because the number is what is being
 * scanned for; reversing them makes a six-tile grid read as six sentences. Tone
 * colours the figure rather than the tile, so five neutral tiles and one red one
 * do not turn the dashboard into a traffic light.
 */
export function StatTile({ label, value, hint, tone = 'neutral', loading = false }: StatTileProps) {
  return (
    <Card padding="md" className={cx(styles.tile, styles[tone])}>
      {loading ? (
        <Skeleton shape="rounded" width="3.5rem" height="1.9rem" />
      ) : (
        <span className={styles.value}>{value}</span>
      )}
      <span className={styles.label}>{label}</span>
      {hint ? <span className={styles.hint}>{hint}</span> : null}
    </Card>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}
