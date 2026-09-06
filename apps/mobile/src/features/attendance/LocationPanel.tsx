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
 */
export function LocationPanel({ geo, sites, maxAccuracyMeters, isAdmin }: LocationPanelProps) {
  if (sites.length === 0) {
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
  if (!nearest) return null;

  const accurate = geo.fix.accuracy <= maxAccuracyMeters;
  const within = nearest.withinFence;
  const ok = within && accurate;

  return (
    <Card>
      <div className={styles.panel}>
        <div className={styles.headline}>
          <span
            className={cx(styles.headlineIcon, ok ? styles.iconOk : styles.iconWarn)}
            aria-hidden="true"
          >
            {ok ? <CheckIcon size="1.35rem" /> : <MapPinIcon size="1.35rem" />}
          </span>
          <div className={styles.headlineText}>
            <p className={styles.title}>
              {within
                ? `You are at ${nearest.site.name}`
                : `${formatDistance(nearest.distanceM)} from ${nearest.site.name}`}
            </p>
            <p className={styles.detail}>
              {within
                ? `${formatDistance(nearest.distanceM)} from the centre — inside the ${formatDistance(nearest.site.radiusMeters)} geofence.`
                : `This site accepts punches within ${formatDistance(nearest.site.radiusMeters)}.`}
            </p>
          </div>
        </div>

        <RangeMeter
          distanceM={nearest.distanceM}
          radiusM={nearest.site.radiusMeters}
          siteName={nearest.site.name}
        />

        {accurate ? null : (
          <Banner
            tone="warning"
            icon={<AlertIcon size="1.15rem" />}
            title={`Your fix is only accurate to ${formatDistance(geo.fix.accuracy)}`}
            description={`Punches need ${formatDistance(maxAccuracyMeters)} or better. Step outside, away from tall buildings, and try again.`}
          />
        )}

        <div className={styles.footerRow}>
          <span className={styles.accuracy}>
            Accurate to {formatDistance(geo.fix.accuracy)} · limit{' '}
            {formatDistance(maxAccuracyMeters)}
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
