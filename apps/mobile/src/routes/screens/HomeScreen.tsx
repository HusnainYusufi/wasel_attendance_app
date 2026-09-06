import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ErrorCode,
  PunchType,
  formatDistance,
  type PunchRequest,
  type PunchResponse,
} from '@wasel/contracts';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  attendanceApi,
  isApiError,
  isErrorCode,
  isOffline,
  queryKeys,
  toDisplayMessage,
} from '../../api';
import { useAuth } from '../../auth';
import { Banner, type BannerTone } from '../../components/Banner';
import { LoadFailure } from '../../components/LoadFailure';
import { Button, Card, Screen, Skeleton, buttonClassNames } from '../../design';
import { AccountButton } from '../../features/account/AccountButton';
import { LocationPanel } from '../../features/attendance/LocationPanel';
import { TodayCard } from '../../features/attendance/TodayCard';
import { GeolocationFailure } from '../../features/geolocation/geolocation';
import { useGeolocation } from '../../features/geolocation/useGeolocation';
import { formatFullDate, formatTimeWithSeconds } from '../../lib/datetime';
import { hapticError, hapticSuccess, hapticTap, hapticWarning } from '../../lib/haptics';
import { sentences } from '../../lib/text';
import { useLiveClock } from '../../lib/useLiveClock';
import { paths } from '../paths';
import styles from './HomeScreen.module.css';

interface PunchNotice {
  tone: BannerTone;
  title: string;
  description?: string;
  /** Offers a link to site management — admins only, since only they can act. */
  siteLink?: boolean;
  /** The punch state on the server may have moved on; re-read it. */
  refresh?: boolean;
}

const ACTION_LABEL: Record<PunchType, string> = {
  [PunchType.CHECK_IN]: 'Check in',
  [PunchType.CHECK_OUT]: 'Check out',
};

const PROGRESS_LABEL: Record<PunchType, string> = {
  [PunchType.CHECK_IN]: 'Checking in…',
  [PunchType.CHECK_OUT]: 'Checking out…',
};

export default function HomeScreen() {
  const { user, isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const geo = useGeolocation({ auto: true });
  const now = useLiveClock();

  const [notice, setNotice] = useState<PunchNotice | null>(null);
  // A second latch behind `Button loading`: a fast double-tap can dispatch two
  // clicks before React re-renders the button as disabled, and two punches is
  // precisely the bug this screen must not have.
  const punchLatch = useRef(false);

  const statusQuery = useQuery({
    queryKey: queryKeys.attendance.status(),
    queryFn: ({ signal }) => attendanceApi.status(signal),
  });

  const status = statusQuery.data;
  const timezone = status?.timezone ?? user?.timezone ?? 'UTC';

  const punch = useMutation<PunchResponse, unknown, { type: PunchType }>({
    mutationFn: async ({ type }) => {
      // Re-acquired rather than reusing whatever is on screen: a fix from four
      // minutes ago may describe a car park the user has since walked out of,
      // and the server judges the coordinates as the position *right now*.
      const fix = await geo.ensureFresh();
      const body: PunchRequest = {
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracy: fix.accuracy,
        // Recorded for tamper analysis only — the server's clock decides the
        // work date, so a wrong phone clock cannot backdate attendance.
        deviceTime: new Date().toISOString(),
      };
      return type === PunchType.CHECK_IN
        ? attendanceApi.checkIn(body)
        : attendanceApi.checkOut(body);
    },
    onSuccess: (result) => {
      hapticSuccess();
      const verb = result.type === PunchType.CHECK_IN ? 'Checked in' : 'Checked out';
      setNotice({
        tone: 'success',
        title: `${verb} at ${result.site.name}`,
        description: `Recorded ${formatDistance(result.distanceM)} from the site centre.`,
      });
      // No toast: the banner above already says this, in the exact spot the
      // user is looking, and the toast viewport sits on top of the punch dock.
      void queryClient.invalidateQueries({ queryKey: queryKeys.attendance.all });
      // An admin who opens the dashboard next should not read stale tiles.
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.overview() });
    },
    onError: (error: unknown) => {
      const described = describePunchFailure(error);
      if (described.tone === 'danger') hapticError();
      else hapticWarning();
      setNotice(described);
      if (described.refresh) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.attendance.all });
      }
    },
    onSettled: () => {
      punchLatch.current = false;
    },
  });

  const runPunch = useCallback(
    (type: PunchType) => {
      if (punchLatch.current || punch.isPending) return;
      punchLatch.current = true;
      setNotice(null);
      hapticTap();
      punch.mutate({ type });
    },
    [punch],
  );

  // A success message is a receipt, not a fixture: the record card below carries
  // the same facts permanently, so the banner steps aside.
  useEffect(() => {
    if (notice?.tone !== 'success') return;
    const timer = setTimeout(() => setNotice(null), 9000);
    return () => clearTimeout(timer);
  }, [notice]);

  const frame = (children: ReactNode) => (
    <Screen
      title="Today"
      eyebrow={user?.organizationName}
      subtitle={formatFullDate(now, timezone)}
      action={<AccountButton />}
    >
      <Card variant="accent">
        <div className={styles.clockCard}>
          {/* Deliberately not a live region: a clock that announces itself every
              second makes the screen unusable with a screen reader. It is read
              on demand, like a wall clock. */}
          <span className={styles.clock}>{formatTimeWithSeconds(now, timezone)}</span>
          <span className={styles.clockMeta}>{timezone.replace(/_/g, ' ')}</span>
        </div>
      </Card>
      {children}
    </Screen>
  );

  if (statusQuery.isPending) {
    return frame(
      <div className={styles.skeletonStack} aria-busy="true">
        <span className="u-visually-hidden">Loading today&rsquo;s attendance</span>
        <Skeleton shape="rounded" height="7rem" />
        <Skeleton shape="rounded" height="11rem" />
        <Skeleton shape="rounded" height="4rem" />
      </div>,
    );
  }

  if (statusQuery.isError || !status) {
    return frame(
      <LoadFailure
        error={statusQuery.error}
        subject="today's attendance"
        onRetry={() => void statusQuery.refetch()}
      />,
    );
  }

  // Closing an open shift takes precedence over opening a new one. The server
  // never offers both — an open shift withdraws `canCheckIn`, because a second
  // record opened on top of the first strands a whole night as INCOMPLETE — so
  // this is an ordering, not a choice between two live actions.
  const primary: PunchType | null = status.canCheckOut
    ? PunchType.CHECK_OUT
    : status.canCheckIn
      ? PunchType.CHECK_IN
      : null;
  const busyLabel = geo.isLocating
    ? 'Finding you…'
    : primary
      ? PROGRESS_LABEL[primary]
      : 'Working…';

  const openShift = status.today !== null && status.today.checkOutAt === null;
  const dayClosed = status.today !== null && status.today.checkOutAt !== null;

  // What the dock says when there is nothing to tap.
  //
  // "Done for today" is only true when the day was actually closed. With no
  // active site the server withdraws `canCheckOut` *mid-shift* — the punch would
  // have nothing to measure against — and a disabled button claiming the day was
  // finished would be a lie about a shift that is still running. Name the action
  // that is unavailable, and say underneath it why it is.
  const idle =
    dayClosed || status.sites.length > 0
      ? { label: 'Done for today', hint: 'You have checked in and out. The record is above.' }
      : {
          label: openShift ? 'Check out' : 'Check in',
          hint: isAdmin
            ? 'No active site to punch against. Add one to record attendance.'
            : 'No active site — ask an administrator.',
        };

  return frame(
    <>
      <LocationPanel
        geo={geo}
        sites={status.sites}
        maxAccuracyMeters={status.maxAccuracyMeters}
        isAdmin={isAdmin}
      />

      {status.today ? (
        <TodayCard record={status.today} timezone={timezone} currentWorkDate={status.workDate} />
      ) : null}

      <div className={styles.dock} data-sticky-dock>
        {notice ? (
          <Banner
            tone={notice.tone}
            title={notice.title}
            description={notice.description}
            action={
              notice.siteLink && isAdmin ? (
                <Link
                  to={paths.adminSites}
                  className={buttonClassNames({ variant: 'secondary', size: 'sm' })}
                >
                  Manage sites
                </Link>
              ) : undefined
            }
          />
        ) : null}

        {primary ? (
          <Button
            size="xl"
            fullWidth
            variant={primary === PunchType.CHECK_IN ? 'success' : 'primary'}
            loading={punch.isPending}
            onClick={() => runPunch(primary)}
          >
            {punch.isPending ? busyLabel : ACTION_LABEL[primary]}
          </Button>
        ) : (
          <Button size="xl" fullWidth disabled>
            {idle.label}
          </Button>
        )}

        <p className={styles.dockHint}>
          {primary ? 'Your location is checked the moment you tap.' : idle.hint}
        </p>
      </div>
    </>,
  );
}

/**
 * Every way a punch can fail, and what the user should do about each.
 *
 * Branching is on `error.code` throughout. The server's own message is used
 * verbatim where it is specific to this attempt — "You are 9.6 km from Head
 * Office, which accepts punches within 150 m" is better copy than anything that
 * could be written here without knowing the distance.
 */
function describePunchFailure(error: unknown): PunchNotice {
  if (error instanceof GeolocationFailure) {
    return {
      tone: 'warning',
      title: 'Nothing was recorded — your location is not confirmed',
      description: error.message,
    };
  }

  if (isErrorCode(error, ErrorCode.OUT_OF_RANGE)) {
    return {
      tone: 'warning',
      title: 'Too far from your site',
      description: sentences(
        toDisplayMessage(error),
        'Move closer, update your location, and tap again',
      ),
    };
  }

  if (isErrorCode(error, ErrorCode.LOW_GPS_ACCURACY)) {
    return {
      tone: 'warning',
      title: 'Your location is not precise enough',
      description: sentences(
        toDisplayMessage(error),
        'Step outside, away from tall buildings, then try again',
      ),
    };
  }

  if (isErrorCode(error, ErrorCode.NO_ACTIVE_SITE)) {
    return {
      tone: 'warning',
      title: 'No active site to punch against',
      description: toDisplayMessage(error),
      siteLink: true,
    };
  }

  if (isErrorCode(error, ErrorCode.SHIFT_STILL_OPEN)) {
    // Not a duplicate tap: a shift from an earlier business day was never
    // closed, and the server refuses to open a second one on top of it because
    // that strands the first as INCOMPLETE forever. The resolving action is a
    // check-out, which the refreshed status turns the button below into.
    return {
      tone: 'warning',
      title: 'Your previous shift is still open',
      description: 'Check out of it first — the button below closes it. Then you can start today.',
      refresh: true,
    };
  }

  if (isErrorCode(error, ErrorCode.SHIFT_TOO_SHORT)) {
    // The server deliberately leaves the shift open, so nothing was lost and
    // nothing has to be undone — the same button works again in a moment. Said
    // calmly, because a red banner would suggest the day is now broken.
    return {
      tone: 'accent',
      title: 'That was too quick to record',
      description: sentences(toDisplayMessage(error), 'Tap check out again in a moment'),
    };
  }

  if (
    isErrorCode(
      error,
      ErrorCode.ALREADY_CHECKED_IN,
      ErrorCode.ALREADY_CHECKED_OUT,
      ErrorCode.NOT_CHECKED_IN,
    )
  ) {
    // Usually a second device, or a tap that did land after all. Not the user's
    // mistake, so it is stated calmly and the screen re-reads the real state.
    return {
      tone: 'accent',
      title: 'Already recorded',
      description: toDisplayMessage(error),
      refresh: true,
    };
  }

  if (isOffline(error)) {
    return {
      tone: 'danger',
      title: 'Nothing was recorded',
      description: 'The server could not be reached. Check your connection and tap again.',
    };
  }

  if (isApiError(error) && error.status >= 500) {
    return {
      tone: 'danger',
      title: 'The server could not record this',
      description: 'This is not your device — try again in a moment.',
    };
  }

  return { tone: 'danger', title: 'Could not record this', description: toDisplayMessage(error) };
}
