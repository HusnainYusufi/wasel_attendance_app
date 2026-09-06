import { formatDistance } from '@wasel/contracts';
import type { CSSProperties } from 'react';
import { cx } from '../../design';
import styles from './RangeMeter.module.css';

export interface RangeMeterProps {
  /** How far the device is from the site, in metres. */
  distanceM: number;
  /** The geofence the server will measure against, in metres. */
  radiusM: number;
  siteName: string;
}

/**
 * Distance against geofence, drawn to scale.
 *
 * The number alone ("9.6 km") does not answer the question the user is actually
 * asking, which is *am I close?* — that needs the radius in the same picture.
 * The scale grows with the distance so the marker never pins to the end and
 * stops conveying anything; the end label states what the scale is, so the
 * drawing can never imply a precision the numbers do not have.
 *
 * It is decorative: `aria-hidden`, because the sentence above it already says
 * the distance, the site and the radius in words.
 */
export function RangeMeter({ distanceM, radiusM, siteName }: RangeMeterProps) {
  const within = distanceM <= radiusM;

  // Always show the fence at a readable width, and always leave headroom past
  // the marker so "just outside" and "far outside" do not look identical.
  const scaleMax = Math.max(radiusM * 1.6, distanceM * 1.15, 1);
  const fencePct = Math.min(100, (radiusM / scaleMax) * 100);
  const markerPct = Math.min(100, (distanceM / scaleMax) * 100);

  return (
    <div className={styles.meter} aria-hidden="true">
      <div className={styles.track}>
        <span
          className={cx(styles.fence, !within && styles.fenceOut)}
          style={{ width: `${fencePct}%` } satisfies CSSProperties}
        />
        <span
          className={cx(styles.marker, !within && styles.markerOut)}
          style={{ insetInlineStart: `${markerPct}%` } satisfies CSSProperties}
        />
      </div>
      <div className={styles.scale}>
        <span>{siteName}</span>
        <span className={styles.scaleEnd}>{formatDistance(scaleMax)}</span>
      </div>
    </div>
  );
}
