import { findNearestSite, formatDistance, type GeofenceSite } from '@wasel/contracts';
import { Link } from 'react-router-dom';
import { Banner } from '../../components/Banner';
import {
  Button,
  Card,
  MapPinIcon,
  Spinner,
  buttonClassNames,
  cx,
  AlertIcon,
  CheckIcon,
} from '../../design';
import { paths } from '../../routes/paths';
import type { GeoErrorKind } from '../geolocation/geolocation';
import type { UseGeolocation } from '../geolocation/useGeolocation';
import { RangeMeter } from './RangeMeter';
import styles from './LocationPanel.module.css';

export interface LocationPanelProps {
  geo: UseGeolocation;
  sites: readonly GeofenceSite[];
  maxAccuracyMeters: number;
  /**
   * Whether the server will refuse a punch taken outside a fence.
   *
   * `false` changes what this panel *is*, not merely how it is worded: it stops
   * being a check the user has to pass and becomes a statement of what is about
   * to be written down. Nothing on it may then read as a warning, because there
   * is nothing for the user to do about any of it.
   */
  enforceGeofence: boolean;
  isAdmin: boolean;
}

/** Whether asking again can plausibly help, and what to call the button if so. */
const RETRY_LABEL: Record<GeoErrorKind, string | null> = {
  unsupported: null,
  'insecure-context': null,
  'permission-denied': 'Allow location',
  'permission-blocked': 'I have enabled it — try again',
  unavailable: 'Try again',
  timeout: 'Try again',
  'accuracy-unknown': 'Try again',
  'accuracy-absurd': 'Try again',
};

const ERROR_TITLE: Record<GeoErrorKind, string> = {
  unsupported: 'Location is not available here',
  'insecure-context': 'Location needs a secure connection',
  'permission-denied': 'Location permission is needed',
  'permission-blocked': 'Location is blocked',
  unavailable: 'No location fix yet',
  timeout: 'Finding you is taking too long',
  'accuracy-unknown': 'Your position cannot be trusted yet',
  'accuracy-absurd': 'Your position is too vague',
};

/**
 * Where the user is, relative to where they are supposed to be.
 *
 * Distances are computed with `distanceInMeters` from the contract — the very
 * function the server runs — so the number on screen is the number that will be
 * enforced. Recomputing it here with a slightly different earth radius would
 * produce the worst possible bug in this app: a screen that says "12 m away"
 * next to a rejection that says "out of range".
 *
 * With `enforceGeofence: false` the same numbers are shown and none of them is a
 * verdict. The geofence bar, the amber accuracy banner and the "no site
 * configured" warning all disappear — each of them exists to answer *may I punch
 * here?*, a question that no longer has a wrong answer — and what is left is the
 * honest statement of what the punch will record.
 */
export function LocationPanel({
  geo,
  sites,
  maxAccuracyMeters,
  enforceGeofence,
  isAdmin,
}: LocationPanelProps) {
  if (sites.length === 0 && enforceGeofence) {
    return (
      <Banner
        tone="warning"
        title="No active site is configured"
        description={
          isAdmin
            ? 'Attendance cannot be recorded until at least one site with a geofence exists.'
            : 'Attendance cannot be recorded yet. Ask an administrator to add your site.'
        }
        action={
          isAdmin ? (
            <Link to={paths.adminSites} className={buttonClassNames({ variant: 'secondary' })}>
              Add a site
            </Link>
          ) : undefined
        }
      />
    );
  }

  if (geo.status === 'error' && geo.errorKind) {
    // Still a warning with the fence off: the punch is accepted from anywhere,
    // but only if the device can say where "anywhere" was.
    const retryLabel = RETRY_LABEL[geo.errorKind];
    return (
      <Banner
        tone="warning"
        title={ERROR_TITLE[geo.errorKind]}
        description={geo.errorMessage ?? undefined}
        action={
          retryLabel ? (
            <Button
              variant="secondary"
              loading={geo.isLocating}
              onClick={() => void geo.refresh().catch(() => undefined)}
            >
              {retryLabel}
            </Button>
          ) : undefined
        }
      />
    );
  }

  if (!geo.fix) {
    return (
      <Card>
        <div className={styles.loading}>
          <Spinner size="md" label="Finding your location" />
          <span>Finding your location…</span>
        </div>
      </Card>
    );
  }

  const nearest = findNearestSite(geo.fix, sites);
  const accurate = geo.fix.accuracy <= maxAccuracyMeters;
  const within = nearest?.withinFence ?? false;
  const ok = within && accurate;

  return (
    <Card>
      <div className={styles.panel}>
        <div className={styles.headline}>
          <span
            className={cx(
              styles.headlineIcon,
              !enforceGeofence ? styles.iconInfo : ok ? styles.iconOk : styles.iconWarn,
            )}
            aria-hidden="true"
          >
            {enforceGeofence && ok ? <CheckIcon size="1.35rem" /> : <MapPinIcon size="1.35rem" />}
          </span>
          <div className={styles.headlineText}>
            <p className={styles.title}>{headline(nearest)}</p>
            <p className={styles.detail}>{detail(nearest, enforceGeofence)}</p>
          </div>
        </div>

        {/* The meter draws distance against the fence, which only answers "am I
            close enough?". With no fence to be close enough to, a marker pinned
            far past the band would read as a failure the user cannot fix. */}
        {enforceGeofence && nearest ? (
          <RangeMeter
            distanceM={nearest.distanceM}
            radiusM={nearest.site.radiusMeters}
            siteName={nearest.site.name}
          />
        ) : null}

        {enforceGeofence && !accurate ? (
          <Banner
            tone="warning"
            icon={<AlertIcon size="1.15rem" />}
            title={`Your fix is only accurate to ${formatDistance(geo.fix.accuracy)}`}
            description={`Punches need ${formatDistance(maxAccuracyMeters)} or better. Step outside, away from tall buildings, and try again.`}
          />
        ) : null}

        <div className={styles.footerRow}>
          <span className={styles.accuracy}>
            {/* Deliberately parallel to the enforcing form: same sentence, and the
                one word that changes is the one that matters. */}
            {enforceGeofence
              ? `Accurate to ${formatDistance(geo.fix.accuracy)} · limit ${formatDistance(maxAccuracyMeters)}`
              : `Accurate to ${formatDistance(geo.fix.accuracy)} · no limit`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            loading={geo.isLocating}
            onClick={() => void geo.refresh().catch(() => undefined)}
          >
            Update location
          </Button>
        </div>
      </div>
    </Card>
  );
}

type Nearest = ReturnType<typeof findNearestSite>;

/** The one line that says where the user is. */
function headline(nearest: Nearest): string {
  if (nearest === null) return 'No site to measure from';
  if (nearest.withinFence) return `You are at ${nearest.site.name}`;
  return `${formatDistance(nearest.distanceM)} from ${nearest.site.name}`;
}

/** …and the one under it that says what that means for the punch. */
function detail(nearest: Nearest, enforceGeofence: boolean): string {
  if (!enforceGeofence) {
    return nearest === null
      ? 'Your coordinates and accuracy are still recorded with the punch.'
      : 'Recorded with your punch. Punches here are accepted from anywhere.';
  }
  if (nearest === null) return 'Your coordinates are recorded with the punch.';
  // Enforcing, and a site exists: the fence is the point of the sentence.
  return nearest.withinFence
    ? `${formatDistance(nearest.distanceM)} from the centre — inside the ${formatDistance(nearest.site.radiusMeters)} geofence.`
    : `This site accepts punches within ${formatDistance(nearest.site.radiusMeters)}.`;
}
