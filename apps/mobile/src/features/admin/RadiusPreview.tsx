import { SITE_RADIUS_MAX_M, SITE_RADIUS_MIN_M, formatDistance } from '@wasel/contracts';
import styles from './RadiusPreview.module.css';

/** Comfortable walking pace, metres per minute. */
const WALK_M_PER_MIN = 80;
/** The dashed reference circle, in metres. */
const REFERENCE_M = 100;

/**
 * How long it takes to walk the radius, phrased the way a person would say it.
 * Below a minute the number is meaningless, so it becomes "moments".
 */
function walkTime(radiusMeters: number): string {
  const minutes = radiusMeters / WALK_M_PER_MIN;
  if (minutes < 0.6) return 'a few seconds';
  if (minutes < 1.5) return 'about a minute';
  if (minutes < 60) return `about a ${Math.round(minutes)} minute`;
  return `about a ${Math.round(minutes / 60)} hour`;
}

export interface RadiusPreviewProps {
  radiusMeters: number;
}

/**
 * A geofence radius, made judgeable.
 *
 * "150" is a number an admin has no intuition for. Two things fix that: a circle
 * drawn to scale against a fixed 100 m reference ring, and how long it takes to
 * walk. Both are approximations and are labelled as such — a map would be more
 * precise, but it needs a tile provider, a network round trip and an API key
 * this app deliberately does not have.
 */
export function RadiusPreview({ radiusMeters }: RadiusPreviewProps) {
  const valid =
    Number.isFinite(radiusMeters) &&
    radiusMeters >= SITE_RADIUS_MIN_M &&
    radiusMeters <= SITE_RADIUS_MAX_M;

  if (!valid) {
    return (
      <div className={styles.preview}>
        <div className={styles.figure} aria-hidden="true">
          <span className={styles.centre} />
        </div>
        <div className={styles.text}>
          <span className={styles.headline}>Enter a radius</span>
          <span className={styles.detail}>
            Between {SITE_RADIUS_MIN_M} m and {formatDistance(SITE_RADIUS_MAX_M)}. Below{' '}
            {SITE_RADIUS_MIN_M} m consumer GPS cannot tell inside from outside.
          </span>
        </div>
      </div>
    );
  }

  // Both circles share one scale so the comparison is honest; the larger of the
  // two fills the box, and a square-root scale keeps a 5 km fence from making
  // the 100 m reference an invisible dot.
  const largest = Math.max(radiusMeters, REFERENCE_M);
  const ringPct = Math.sqrt(radiusMeters / largest) * 100;
  const referencePct = Math.sqrt(REFERENCE_M / largest) * 100;

  return (
    <div className={styles.preview}>
      <div className={styles.figure} aria-hidden="true">
        <span className={styles.ring} style={{ width: `${ringPct}%`, aspectRatio: '1' }} />
        {/* Painted after the fence, not before: the fence carries a solid fill,
            so a reference ring drawn underneath it disappears the moment the
            fence is the larger of the two — which is most of the time. */}
        <span
          className={styles.reference}
          style={{ width: `${referencePct}%`, aspectRatio: '1' }}
        />
        <span className={styles.centre} />
      </div>
      <div className={styles.text}>
        <span className={styles.headline}>{formatDistance(radiusMeters)} in every direction</span>
        <span className={styles.detail}>
          A circle {formatDistance(radiusMeters * 2)} across — {walkTime(radiusMeters)} walk from
          the edge to the centre.
        </span>
        <span className={styles.legend}>Dashed ring = 100 m, for scale.</span>
      </div>
    </div>
  );
}
