import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ErrorCode,
  SITE_RADIUS_DEFAULT_M,
  SITE_RADIUS_MAX_M,
  SITE_RADIUS_MIN_M,
  formatDistance,
  type CreateSiteRequest,
  type SiteDto,
  type UpdateSiteRequest,
} from '@wasel/contracts';
import { useState, type FormEvent } from 'react';
import {
  adminApi,
  fieldErrors,
  isErrorCode,
  isOffline,
  queryKeys,
  toDisplayMessage,
} from '../../api';
import { Banner } from '../../components/Banner';
import { Button, Input, MapPinIcon, Sheet, useToast } from '../../design';
import { GeolocationFailure, locate } from '../geolocation/geolocation';
import { RadiusPreview } from './RadiusPreview';
import styles from './form.module.css';

export type SiteSheetTarget = { mode: 'create' } | { mode: 'edit'; site: SiteDto };

export interface SiteSheetProps {
  target: SiteSheetTarget | null;
  onClose: () => void;
}

interface FormState {
  name: string;
  address: string;
  latitude: string;
  longitude: string;
  radiusMeters: string;
  isActive: boolean;
}

function initialForm(target: SiteSheetTarget | null): FormState {
  if (target?.mode === 'edit') {
    return {
      name: target.site.name,
      address: target.site.address ?? '',
      latitude: String(target.site.latitude),
      longitude: String(target.site.longitude),
      radiusMeters: String(target.site.radiusMeters),
      isActive: target.site.isActive,
    };
  }
  return {
    name: '',
    address: '',
    latitude: '',
    longitude: '',
    radiusMeters: String(SITE_RADIUS_DEFAULT_M),
    isActive: true,
  };
}

/** Six decimal places is ~0.1 m — far finer than any geofence needs, and it
 *  keeps a pasted coordinate from being silently truncated. */
function roundCoordinate(value: number): string {
  return value.toFixed(6);
}

export function SiteSheet({ target, onClose }: SiteSheetProps) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState<FormState>(() => initialForm(target));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [locating, setLocating] = useState(false);
  const [fixAccuracy, setFixAccuracy] = useState<number | null>(null);

  /**
   * The last target the sheet was opened with. Holding it after `target` goes
   * null is what keeps the panel's contents on screen through its exit
   * animation instead of collapsing to an empty box.
   */
  const [shown, setShown] = useState(target);
  if (target !== null && target !== shown) {
    // React's sanctioned "adjust state when a prop changes" — done during
    // render, so the new form is never painted holding the old site's values.
    setShown(target);
    setForm(initialForm(target));
    setErrors({});
    setFormError(null);
    setConfirmingDelete(false);
    setFixAccuracy(null);
  }

  const open = target !== null;
  const editing = shown?.mode === 'edit' ? shown.site : null;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.admin.all });
    // A site's geofence is what the home screen measures against.
    void queryClient.invalidateQueries({ queryKey: queryKeys.attendance.all });
  };

  const applyError = (error: unknown) => {
    if (isErrorCode(error, ErrorCode.SITE_NAME_TAKEN)) {
      setErrors({ name: 'Another site already has that name.' });
      return;
    }
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
  };

  const create = useMutation({
    mutationFn: (body: CreateSiteRequest) => adminApi.createSite(body),
    onSuccess: (site) => {
      toast.show({ tone: 'success', title: `${site.name} added` });
      invalidate();
      onClose();
    },
    onError: applyError,
  });

  const update = useMutation({
    mutationFn: (input: { id: string; body: UpdateSiteRequest }) =>
      adminApi.updateSite(input.id, input.body),
    onSuccess: (site) => {
      toast.show({ tone: 'success', title: `${site.name} updated` });
      invalidate();
      onClose();
    },
    onError: applyError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => adminApi.deleteSite(id),
    onSuccess: () => {
      toast.show({
        tone: 'success',
        title: `${editing?.name ?? 'Site'} deleted`,
        description: 'Attendance already recorded against it is unaffected.',
      });
      invalidate();
      onClose();
    },
    onError: (error) => {
      setConfirmingDelete(false);
      applyError(error);
    },
  });

  const busy = create.isPending || update.isPending || remove.isPending;

  const fillFromCurrentLocation = async () => {
    if (locating) return;
    setLocating(true);
    setFormError(null);
    try {
      const fix = await locate();
      setForm((f) => ({
        ...f,
        latitude: roundCoordinate(fix.latitude),
        longitude: roundCoordinate(fix.longitude),
      }));
      setErrors((current) => ({ ...current, latitude: '', longitude: '' }));
      // Reported inline under the fields rather than as a toast: the toast
      // viewport sits over the bottom sheet and would cover the very
      // coordinates it is announcing.
      setFixAccuracy(fix.accuracy);
    } catch (error) {
      setFormError(
        error instanceof GeolocationFailure
          ? error.message
          : 'Your location could not be determined.',
      );
    } finally {
      setLocating(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setErrors({});
    setFormError(null);

    const local: Record<string, string> = {};
    const latitude = Number(form.latitude);
    const longitude = Number(form.longitude);
    const radius = Number(form.radiusMeters);

    if (form.name.trim().length < 2) local['name'] = 'Enter at least 2 characters.';
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      local['latitude'] = 'Between -90 and 90.';
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      local['longitude'] = 'Between -180 and 180.';
    }
    if (!Number.isInteger(radius) || radius < SITE_RADIUS_MIN_M || radius > SITE_RADIUS_MAX_M) {
      local['radiusMeters'] =
        `A whole number between ${SITE_RADIUS_MIN_M} and ${SITE_RADIUS_MAX_M}.`;
    }
    if (Object.keys(local).length > 0) {
      setErrors(local);
      return;
    }

    const address = form.address.trim();

    if (!editing) {
      create.mutate({
        name: form.name.trim(),
        ...(address ? { address } : {}),
        latitude,
        longitude,
        radiusMeters: radius,
        isActive: form.isActive,
      });
      return;
    }

    const body: UpdateSiteRequest = {};
    if (form.name.trim() !== editing.name) body.name = form.name.trim();
    if (address !== (editing.address ?? '')) body.address = address;
    if (latitude !== editing.latitude) body.latitude = latitude;
    if (longitude !== editing.longitude) body.longitude = longitude;
    if (radius !== editing.radiusMeters) body.radiusMeters = radius;
    if (form.isActive !== editing.isActive) body.isActive = form.isActive;

    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    update.mutate({ id: editing.id, body });
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={confirmingDelete ? 'Delete site' : editing ? 'Edit site' : 'Add a site'}
      description={
        confirmingDelete
          ? undefined
          : 'A check-in is accepted only inside this circle, measured from its centre.'
      }
      dismissible={!confirmingDelete}
      footer={
        confirmingDelete ? (
          <>
            <Button variant="secondary" onClick={() => setConfirmingDelete(false)} disabled={busy}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => editing && remove.mutate(editing.id)}
            >
              Delete site
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form="site-form" loading={create.isPending || update.isPending}>
              {editing ? 'Save changes' : 'Add site'}
            </Button>
          </>
        )
      }
    >
      {formError ? <Banner tone="danger" title={formError} /> : null}

      {confirmingDelete && editing ? (
        <div className={styles.form}>
          <Banner
            tone="danger"
            title={`Delete ${editing.name}?`}
            description="Nobody will be able to punch against it any more. Attendance already recorded there is kept, so past exports stay complete. To stop check-ins without deleting, switch the site off instead."
          />
        </div>
      ) : (
        <form id="site-form" className={styles.form} onSubmit={onSubmit}>
          <Input
            label="Site name"
            required
            value={form.name}
            error={errors['name']}
            onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
            autoCapitalize="words"
            placeholder="Head Office"
          />

          <Input
            label="Address"
            optionalText="Optional"
            value={form.address}
            error={errors['address']}
            onChange={(event) => setForm((f) => ({ ...f, address: event.target.value }))}
            autoComplete="street-address"
            hint="Shown to admins only; it plays no part in the geofence."
          />

          <span className={styles.sectionTitle}>Centre of the geofence</span>

          <Button
            variant="secondary"
            fullWidth
            loading={locating}
            iconStart={<MapPinIcon size="1.1rem" />}
            onClick={() => void fillFromCurrentLocation()}
          >
            {locating ? 'Finding you…' : 'Use my current location'}
          </Button>

          <div className={styles.pair}>
            <Input
              label="Latitude"
              type="number"
              inputMode="decimal"
              step="any"
              required
              value={form.latitude}
              error={errors['latitude']}
              onChange={(event) => setForm((f) => ({ ...f, latitude: event.target.value }))}
              placeholder="24.713600"
            />
            <Input
              label="Longitude"
              type="number"
              inputMode="decimal"
              step="any"
              required
              value={form.longitude}
              error={errors['longitude']}
              onChange={(event) => setForm((f) => ({ ...f, longitude: event.target.value }))}
              placeholder="46.675300"
            />
          </div>

          {fixAccuracy === null ? null : (
            <p className={styles.inlineNote}>
              Filled from your current position, accurate to {formatDistance(fixAccuracy)}.
            </p>
          )}

          <Input
            label="Radius"
            type="number"
            inputMode="numeric"
            min={SITE_RADIUS_MIN_M}
            max={SITE_RADIUS_MAX_M}
            step={1}
            required
            value={form.radiusMeters}
            error={errors['radiusMeters']}
            onChange={(event) => setForm((f) => ({ ...f, radiusMeters: event.target.value }))}
            hint={`Metres, between ${SITE_RADIUS_MIN_M} and ${SITE_RADIUS_MAX_M}.`}
          />

          <RadiusPreview radiusMeters={Number(form.radiusMeters)} />

          <div className={styles.checkboxRow}>
            <input
              id="site-active"
              type="checkbox"
              className={styles.checkbox}
              checked={form.isActive}
              onChange={(event) => setForm((f) => ({ ...f, isActive: event.target.checked }))}
            />
            <label className={styles.checkboxLabel} htmlFor="site-active">
              <span className={styles.checkboxTitle}>Accept punches here</span>
              <span className={styles.checkboxHint}>
                Switch off to retire a site without deleting it. Existing attendance is unaffected.
              </span>
            </label>
          </div>

          {editing ? (
            <Button
              variant="danger"
              fullWidth
              onClick={() => setConfirmingDelete(true)}
              disabled={busy}
            >
              Delete this site
            </Button>
          ) : null}
        </form>
      )}
    </Sheet>
  );
}
