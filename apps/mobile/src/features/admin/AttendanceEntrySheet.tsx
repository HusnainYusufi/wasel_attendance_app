import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ATTENDANCE_NOTE_MAX_LENGTH,
  ErrorCode,
  MIN_SHIFT_MINUTES,
  type AttendanceEntryDto,
  type UpdateAttendanceEntryRequest,
  type UserDto,
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
import { Button, Input, Select, Sheet, useToast } from '../../design';
import { formatTime, formatWorkDate, isoDateIn } from '../../lib/datetime';
import styles from './form.module.css';

/**
 * What the sheet was opened for.
 *
 * `people` rides along on the create branch because the employee is the one
 * field a correction cannot change: a record already belongs to somebody, and
 * moving it is a delete and a create, not an edit.
 */
export type AttendanceEntryTarget =
  | { mode: 'create'; people: UserDto[]; userId?: string; workDate?: string }
  | { mode: 'edit'; entry: AttendanceEntryDto };

export interface AttendanceEntrySheetProps {
  target: AttendanceEntryTarget | null;
  /** IANA zone the wall clocks are read and written in — the organization's, never the phone's. */
  timezone: string;
  onClose: () => void;
}

interface FormState {
  userId: string;
  workDate: string;
  checkInTime: string;
  checkOutTime: string;
  checkOutNextDay: boolean;
  note: string;
}

/**
 * The calendar date an instant falls on *in the organization's zone*, so the
 * "ends the next day" box reflects what the tenant's own clock saw rather than
 * what the administrator's handset did.
 */
function crossesMidnight(entry: AttendanceEntryDto, timezone: string): boolean {
  if (entry.checkOutAt === null) return false;
  return (
    isoDateIn(timezone, new Date(entry.checkInAt)) !==
    isoDateIn(timezone, new Date(entry.checkOutAt))
  );
}

function initialForm(target: AttendanceEntryTarget | null, timezone: string): FormState {
  if (target?.mode === 'edit') {
    const { entry } = target;
    return {
      userId: entry.userId,
      workDate: entry.workDate,
      checkInTime: formatTime(entry.checkInAt, timezone),
      checkOutTime: entry.checkOutAt === null ? '' : formatTime(entry.checkOutAt, timezone),
      checkOutNextDay: crossesMidnight(entry, timezone),
      // Never prefilled from the record it is correcting. A note explains *this*
      // edit, and inheriting the last one would let "phone died" ride along on a
      // change that had nothing to do with it.
      note: '',
    };
  }
  return {
    userId: target?.mode === 'create' ? (target.userId ?? '') : '',
    workDate: target?.mode === 'create' ? (target.workDate ?? '') : '',
    checkInTime: '',
    checkOutTime: '',
    checkOutNextDay: false,
    note: '',
  };
}

/**
 * Recording and correcting a day by hand.
 *
 * Every field here is a wall clock in the organization's timezone, sent to the
 * server as typed. The client deliberately does no timezone arithmetic of its
 * own: turning "08:47 on 3 March in Riyadh" into an instant needs the tenant's
 * zone and its business-day boundary, and a second implementation of that in a
 * phone is how a timesheet and a payslip come to disagree.
 */
export function AttendanceEntrySheet({ target, timezone, onClose }: AttendanceEntrySheetProps) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState<FormState>(() => initialForm(target, timezone));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  /** Held past `target` going null so the panel keeps its contents through the exit animation. */
  const [shown, setShown] = useState(target);
  if (target !== null && target !== shown) {
    setShown(target);
    setForm(initialForm(target, timezone));
    setErrors({});
    setFormError(null);
    setConfirmingDelete(false);
  }

  const open = target !== null;
  const editing = shown?.mode === 'edit' ? shown.entry : null;
  const people = shown?.mode === 'create' ? shown.people : [];
  const today = isoDateIn(timezone);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.admin.all });
    // The employee's own history and today's card read the very rows this wrote.
    void queryClient.invalidateQueries({ queryKey: queryKeys.attendance.all });
  };

  const applyError = (error: unknown) => {
    if (isErrorCode(error, ErrorCode.CONFLICT)) {
      setErrors({ workDate: 'That day already has a record. Open it and correct it instead.' });
      return;
    }
    if (isErrorCode(error, ErrorCode.SHIFT_TOO_SHORT)) {
      setErrors({
        checkOutTime: `A shift must be at least ${MIN_SHIFT_MINUTES} minute long.`,
      });
      return;
    }
    if (isErrorCode(error, ErrorCode.NOT_FOUND)) {
      setFormError('That record no longer exists. Close this and reload the list.');
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
    mutationFn: () =>
      adminApi.createAttendanceEntry({
        userId: form.userId,
        workDate: form.workDate,
        checkInTime: form.checkInTime,
        checkOutTime: form.checkOutTime === '' ? null : form.checkOutTime,
        checkOutNextDay: form.checkOutTime === '' ? false : form.checkOutNextDay,
        note: form.note.trim(),
      }),
    onSuccess: (entry) => {
      toast.show({
        tone: 'success',
        title: `${formatWorkDate(entry.workDate)} recorded`,
        description: 'It is marked as entered by hand, with your name on it.',
      });
      invalidate();
      onClose();
    },
    onError: applyError,
  });

  const update = useMutation({
    mutationFn: (body: UpdateAttendanceEntryRequest) =>
      adminApi.updateAttendanceEntry(editing?.id ?? '', body),
    onSuccess: (entry) => {
      toast.show({ tone: 'success', title: `${formatWorkDate(entry.workDate)} corrected` });
      invalidate();
      onClose();
    },
    onError: applyError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => adminApi.deleteAttendanceEntry(id),
    onSuccess: () => {
      toast.show({
        tone: 'success',
        title: 'Record removed',
        description: 'The employee can punch that day again.',
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

  const validate = (): Record<string, string> => {
    const local: Record<string, string> = {};
    if (!editing && form.userId === '') local['userId'] = 'Choose who this day belongs to.';
    if (!editing && form.workDate === '') local['workDate'] = 'Choose a date.';
    if (!editing && form.workDate > today) {
      local['workDate'] = 'Attendance cannot be recorded for a day that has not happened.';
    }
    if (form.checkInTime === '') local['checkInTime'] = 'Enter the time they started.';
    if (form.checkOutTime !== '' && !form.checkOutNextDay && form.checkOutTime < form.checkInTime) {
      local['checkOutTime'] = 'Earlier than the check-in. Tick "ends the next day" if it ran over.';
    }
    if (form.note.trim().length < 3) {
      local['note'] = 'Say why this was entered by hand.';
    }
    return local;
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setErrors({});
    setFormError(null);

    const local = validate();
    if (Object.keys(local).length > 0) {
      setErrors(local);
      return;
    }

    if (!editing) {
      create.mutate();
      return;
    }

    // A correction always carries the note, and always carries both clocks: the
    // form was seeded from the record, so sending them restates exactly what is
    // on screen rather than leaving the server to guess which end moved.
    const body: UpdateAttendanceEntryRequest = {
      note: form.note.trim(),
      checkInTime: form.checkInTime,
      checkOutTime: form.checkOutTime === '' ? null : form.checkOutTime,
      ...(form.checkOutTime === '' ? {} : { checkOutNextDay: form.checkOutNextDay }),
    };
    update.mutate(body);
  };

  const title = confirmingDelete
    ? 'Remove this record'
    : editing
      ? `Correct ${formatWorkDate(editing.workDate)}`
      : 'Record a day';

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      description={
        confirmingDelete
          ? undefined
          : `Times are the wall clock in ${timezone.replace(/_/g, ' ')}. The record is stored as entered by hand, under your name.`
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
              Remove record
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="attendance-entry-form"
              loading={create.isPending || update.isPending}
            >
              {editing ? 'Save correction' : 'Record day'}
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
            title={`Remove ${editing.userFullName}'s ${formatWorkDate(editing.workDate)}?`}
            description="The day disappears from every report and export. The removal itself is written to the audit log, with the whole record in it, so it stays recoverable from the trail."
          />
        </div>
      ) : (
        <form id="attendance-entry-form" className={styles.form} onSubmit={onSubmit}>
          {editing ? (
            <Banner
              tone={editing.source === 'MANUAL' ? 'warning' : 'neutral'}
              title={
                editing.source === 'MANUAL'
                  ? `Entered by hand${editing.enteredBy ? ` by ${editing.enteredBy.fullName}` : ''}`
                  : 'Punched by the employee'
              }
              description={
                editing.source === 'MANUAL'
                  ? (editing.note ?? undefined)
                  : 'Saving a correction marks this day as entered by hand and puts your name on it. The location the employee punched from is kept.'
              }
            />
          ) : null}

          {editing ? null : (
            <Select
              label="Employee"
              required
              value={form.userId}
              error={errors['userId']}
              onChange={(event) => setForm((f) => ({ ...f, userId: event.target.value }))}
            >
              <option value="">Choose a person…</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.fullName}
                </option>
              ))}
            </Select>
          )}

          <Input
            label="Work date"
            type="date"
            required
            max={today}
            value={form.workDate}
            error={errors['workDate']}
            disabled={editing !== null}
            onChange={(event) => setForm((f) => ({ ...f, workDate: event.target.value }))}
            hint={
              editing
                ? 'A record cannot move to another day. Remove it and record the right one.'
                : undefined
            }
          />

          <div className={styles.pair}>
            <Input
              label="Check-in"
              type="time"
              required
              value={form.checkInTime}
              error={errors['checkInTime']}
              onChange={(event) => setForm((f) => ({ ...f, checkInTime: event.target.value }))}
            />
            <Input
              label="Check-out"
              type="time"
              optionalText="Optional"
              value={form.checkOutTime}
              error={errors['checkOutTime']}
              hint="Empty leaves the day open."
              onChange={(event) =>
                setForm((f) => ({
                  ...f,
                  checkOutTime: event.target.value,
                  checkOutNextDay: event.target.value === '' ? false : f.checkOutNextDay,
                }))
              }
            />
          </div>

          <div className={styles.checkboxRow}>
            <input
              id="entry-next-day"
              type="checkbox"
              className={styles.checkbox}
              checked={form.checkOutNextDay}
              disabled={form.checkOutTime === ''}
              onChange={(event) =>
                setForm((f) => ({ ...f, checkOutNextDay: event.target.checked }))
              }
            />
            <label className={styles.checkboxLabel} htmlFor="entry-next-day">
              <span className={styles.checkboxTitle}>Ends the next day</span>
              <span className={styles.checkboxHint}>
                For a night shift — in at 23:50, out at 00:10.
              </span>
            </label>
          </div>

          <Input
            label="Reason"
            required
            value={form.note}
            error={errors['note']}
            maxLength={ATTENDANCE_NOTE_MAX_LENGTH}
            onChange={(event) => setForm((f) => ({ ...f, note: event.target.value }))}
            placeholder="Forgot to check out"
            hint="Stored on the record and shown wherever the day appears."
          />

          {editing ? (
            <Button
              variant="danger"
              fullWidth
              onClick={() => setConfirmingDelete(true)}
              disabled={busy}
            >
              Remove this record
            </Button>
          ) : null}
        </form>
      )}
    </Sheet>
  );
}
