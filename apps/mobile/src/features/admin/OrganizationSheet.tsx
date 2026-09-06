import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACCURACY_CEILING_M,
  ErrorCode,
  type OrganizationDto,
  type UpdateOrganizationRequest,
} from '@wasel/contracts';
import { useMemo, useState, type FormEvent } from 'react';
import {
  adminApi,
  authApi,
  fieldErrors,
  isErrorCode,
  isOffline,
  queryKeys,
  toDisplayMessage,
} from '../../api';
import { useAuth } from '../../auth';
import { Banner } from '../../components/Banner';
import { LoadFailure } from '../../components/LoadFailure';
import { Button, Input, Select, Sheet, Skeleton, useToast } from '../../design';
import { formatZoneLabel, supportedTimeZones } from './timezones';
import styles from './form.module.css';

export interface OrganizationSheetProps {
  open: boolean;
  onClose: () => void;
}

interface Draft {
  name: string;
  timezone: string;
  workdayStart: string;
  workdayEnd: string;
  dayStartsAt: string;
  lateGraceMinutes: string;
  maxAccuracyMeters: string;
  enforceGeofence: boolean;
}

function toDraft(org: OrganizationDto): Draft {
  return {
    name: org.name,
    timezone: org.timezone,
    workdayStart: org.workdayStart,
    workdayEnd: org.workdayEnd,
    dayStartsAt: org.dayStartsAt,
    lateGraceMinutes: String(org.lateGraceMinutes),
    maxAccuracyMeters: String(org.maxAccuracyMeters),
    enforceGeofence: org.enforceGeofence,
  };
}

/**
 * Only what actually changed.
 *
 * The two workday bounds move together whenever either one does, because the
 * contract's ordering rule (`start < end`) only fires when both are present — a
 * lone `workdayStart` would slip past it and could be saved past the end time.
 */
function buildPatch(draft: Draft, original: OrganizationDto): UpdateOrganizationRequest {
  const patch: UpdateOrganizationRequest = {};

  if (draft.name.trim() !== original.name) patch.name = draft.name.trim();
  if (draft.timezone !== original.timezone) patch.timezone = draft.timezone;

  if (draft.workdayStart !== original.workdayStart || draft.workdayEnd !== original.workdayEnd) {
    patch.workdayStart = draft.workdayStart;
    patch.workdayEnd = draft.workdayEnd;
  }

  // Sent on its own, never dragged along with the pair above: the contract
  // deliberately places no rule between the day boundary and the workday
  // bounds, because a night-shift tenant needs it outside them.
  if (draft.dayStartsAt !== original.dayStartsAt) patch.dayStartsAt = draft.dayStartsAt;

  const grace = Number(draft.lateGraceMinutes);
  if (Number.isFinite(grace) && grace !== original.lateGraceMinutes) {
    patch.lateGraceMinutes = grace;
  }

  const accuracy = Number(draft.maxAccuracyMeters);
  if (Number.isFinite(accuracy) && accuracy !== original.maxAccuracyMeters) {
    patch.maxAccuracyMeters = accuracy;
  }

  if (draft.enforceGeofence !== original.enforceGeofence) {
    patch.enforceGeofence = draft.enforceGeofence;
  }

  return patch;
}

/**
 * The policy every punch is judged against: which timezone the work date is
 * computed in, when the workday starts, where the business day rolls over, how
 * much lateness is forgiven, and how imprecise a GPS fix may be before it is
 * refused.
 *
 * Changing the timezone moves the tenant's whole notion of "today", so the
 * signed-in profile is re-read afterwards — otherwise every timestamp on screen
 * would keep rendering in the old zone until the next cold start.
 */
export function OrganizationSheet({ open, onClose }: OrganizationSheetProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { updateUser } = useAuth();

  // Only the fields the admin has actually touched. Everything else is derived
  // from the server's current values, so a background refetch corrects an
  // untouched field instead of the form quietly holding a stale copy of it.
  const [edits, setEdits] = useState<Partial<Draft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: queryKeys.admin.organization(),
    queryFn: ({ signal }) => adminApi.organization(signal),
    enabled: open,
  });

  const organization = query.data;
  const draft: Draft | null = organization ? { ...toDraft(organization), ...edits } : null;

  /**
   * Discard edits on the *opening* edge, adjusted during render rather than in
   * an effect: resetting on the closing edge would blank the form mid-way
   * through the sheet's exit animation.
   */
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setEdits({});
      setErrors({});
      setFormError(null);
    }
  }

  const zones = useMemo(
    () => supportedTimeZones(organization?.timezone ?? 'UTC'),
    [organization?.timezone],
  );

  const save = useMutation({
    mutationFn: (patch: UpdateOrganizationRequest) => adminApi.updateOrganization(patch),
    onSuccess: async (updated) => {
      toast.show({ tone: 'success', title: 'Organization settings saved' });
      queryClient.setQueryData(queryKeys.admin.organization(), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.all });
      // The work date, the clock and every rendered timestamp derive from the
      // organization timezone carried on the session profile.
      void queryClient.invalidateQueries({ queryKey: queryKeys.attendance.all });
      try {
        updateUser(await authApi.me());
      } catch {
        // The settings are saved either way; a stale local profile self-corrects
        // on the next launch and must not turn a success into an error.
      }
      onClose();
    },
    onError: (error: unknown) => {
      if (isErrorCode(error, ErrorCode.VALIDATION_FAILED)) {
        const detail = fieldErrors(error);
        if (Object.keys(detail).length > 0) {
          setErrors(detail);
          return;
        }
      }
      setFormError(
        isOffline(error)
          ? 'Nothing was saved — the server could not be reached.'
          : toDisplayMessage(error),
      );
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || !organization || save.isPending) return;

    setErrors({});
    setFormError(null);

    const local: Record<string, string> = {};
    if (draft.name.trim().length < 2) local['name'] = 'Enter at least 2 characters.';
    if (draft.workdayStart >= draft.workdayEnd) {
      // Both are `HH:mm`, so a lexicographic comparison is a chronological one.
      local['workdayEnd'] = 'The workday must end after it starts.';
    }
    const grace = Number(draft.lateGraceMinutes);
    if (!Number.isInteger(grace) || grace < 0 || grace > 720) {
      local['lateGraceMinutes'] = 'Between 0 and 720 minutes.';
    }
    const accuracy = Number(draft.maxAccuracyMeters);
    if (!Number.isInteger(accuracy) || accuracy < 10 || accuracy > ACCURACY_CEILING_M) {
      local['maxAccuracyMeters'] = `Between 10 and ${ACCURACY_CEILING_M} metres.`;
    }
    if (Object.keys(local).length > 0) {
      setErrors(local);
      return;
    }

    const patch = buildPatch(draft, organization);
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    save.mutate(patch);
  };

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setEdits((current) => ({ ...current, [key]: value }));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Organization settings"
      description="The policy every punch is judged against."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="organization-form" loading={save.isPending} disabled={!draft}>
            Save changes
          </Button>
        </>
      }
    >
      {query.isPending ? (
        <div className={styles.form} aria-busy="true">
          <span className="u-visually-hidden">Loading organization settings</span>
          <Skeleton shape="rounded" height="3.5rem" />
          <Skeleton shape="rounded" height="3.5rem" />
          <Skeleton shape="rounded" height="3.5rem" />
        </div>
      ) : query.isError || !draft ? (
        <LoadFailure
          compact
          error={query.error}
          subject="organization settings"
          onRetry={() => void query.refetch()}
        />
      ) : (
        <form id="organization-form" className={styles.form} onSubmit={onSubmit}>
          {formError ? <Banner tone="danger" title={formError} /> : null}

          <Input
            label="Organization name"
            required
            value={draft.name}
            error={errors['name']}
            onChange={(event) => update('name', event.target.value)}
            autoComplete="organization"
          />

          <Select
            label="Timezone"
            required
            hint="Work dates and every displayed time are computed in this zone."
            value={draft.timezone}
            error={errors['timezone']}
            onChange={(event) => update('timezone', event.target.value)}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {formatZoneLabel(zone)}
              </option>
            ))}
          </Select>

          <div className={styles.pair}>
            <Input
              label="Workday starts"
              type="time"
              required
              value={draft.workdayStart}
              error={errors['workdayStart']}
              onChange={(event) => update('workdayStart', event.target.value)}
            />
            <Input
              label="Workday ends"
              type="time"
              required
              value={draft.workdayEnd}
              error={errors['workdayEnd']}
              onChange={(event) => update('workdayEnd', event.target.value)}
            />
          </div>

          <Input
            label="Business day rolls over at"
            type="time"
            required
            hint="When a new business day begins. A 23:00–07:00 shift needs it in the evening — 20:00, say — so the night counts as one day."
            value={draft.dayStartsAt}
            error={errors['dayStartsAt']}
            onChange={(event) => update('dayStartsAt', event.target.value)}
          />

          <Input
            label="Late grace"
            type="number"
            inputMode="numeric"
            min={0}
            max={720}
            step={1}
            required
            hint="Minutes after the start time before a check-in counts as late."
            value={draft.lateGraceMinutes}
            error={errors['lateGraceMinutes']}
            onChange={(event) => update('lateGraceMinutes', event.target.value)}
          />

          <div className={styles.checkboxRow}>
            <input
              id="organization-enforce-geofence"
              type="checkbox"
              className={styles.checkbox}
              checked={draft.enforceGeofence}
              onChange={(event) => update('enforceGeofence', event.target.checked)}
            />
            <label className={styles.checkboxLabel} htmlFor="organization-enforce-geofence">
              <span className={styles.checkboxTitle}>Only accept punches inside a site</span>
              <span className={styles.checkboxHint}>
                Switch off for staff who work away from any site: every punch is accepted wherever
                they are, and the distance from the nearest site is still recorded.
              </span>
            </label>
          </div>

          <Input
            label="Maximum GPS accuracy radius"
            type="number"
            inputMode="numeric"
            min={10}
            max={ACCURACY_CEILING_M}
            step={1}
            required
            disabled={!draft.enforceGeofence}
            hint={
              draft.enforceGeofence
                ? 'Metres. A fix with a larger error radius is refused, however close it claims to be.'
                : 'Not applied while punches are accepted from anywhere. The accuracy is still recorded.'
            }
            value={draft.maxAccuracyMeters}
            error={errors['maxAccuracyMeters']}
            onChange={(event) => update('maxAccuracyMeters', event.target.value)}
          />
        </form>
      )}
    </Sheet>
  );
}
