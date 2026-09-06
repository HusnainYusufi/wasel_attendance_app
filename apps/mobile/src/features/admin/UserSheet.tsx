import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ErrorCode,
  PASSWORD_MIN_LENGTH,
  Role,
  UserStatus,
  type CreateUserRequest,
  type UpdateUserRequest,
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
import { useAuth } from '../../auth';
import { Banner } from '../../components/Banner';
import { Avatar, Badge, Button, Input, LockIcon, Select, Sheet, useToast } from '../../design';
import { sentences } from '../../lib/text';
import styles from './form.module.css';

/** `create` opens straight at the form; `manage` opens at the action menu. */
export type UserSheetTarget = { mode: 'create' } | { mode: 'manage'; user: UserDto };

export interface UserSheetProps {
  target: UserSheetTarget | null;
  onClose: () => void;
}

type View = 'menu' | 'form' | 'password' | 'remove';

interface FormState {
  fullName: string;
  email: string;
  password: string;
  employeeCode: string;
  role: Role;
  status: UserStatus;
}

function initialForm(target: UserSheetTarget | null): FormState {
  if (target?.mode === 'manage') {
    return {
      fullName: target.user.fullName,
      email: target.user.email,
      password: '',
      employeeCode: target.user.employeeCode ?? '',
      role: target.user.role,
      status: target.user.status,
    };
  }
  return {
    fullName: '',
    email: '',
    password: '',
    employeeCode: '',
    role: Role.MEMBER,
    status: UserStatus.ACTIVE,
  };
}

/**
 * Create, edit, reset and remove — all inside one sheet, switching views.
 *
 * One sheet rather than several stacked: two open dialogs mean two focus traps
 * competing for the same document, and the one underneath wins in some browsers.
 */
export function UserSheet({ target, onClose }: UserSheetProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user: currentUser } = useAuth();

  const [view, setView] = useState<View>('menu');
  const [form, setForm] = useState<FormState>(() => initialForm(target));
  const [newPassword, setNewPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  /**
   * The last target the sheet was opened with. Holding it after `target` goes
   * null keeps the panel's contents on screen through its exit animation
   * instead of collapsing to an empty box.
   */
  const [shown, setShown] = useState(target);
  if (target !== null && target !== shown) {
    // React's sanctioned "adjust state when a prop changes" — done during
    // render, so the form is never painted holding the previous person's data.
    setShown(target);
    setView(target.mode === 'create' ? 'form' : 'menu');
    setForm(initialForm(target));
    setNewPassword('');
    setErrors({});
    setFormError(null);
  }

  const open = target !== null;
  const editing = shown?.mode === 'manage' ? shown.user : null;
  const isSelf = editing !== null && currentUser !== null && editing.id === currentUser.id;

  /** The address as the server will store it — see `emailSchema` in the contracts. */
  const normalizedEmail = form.email.trim().toLowerCase();
  /**
   * Warn while the field is being typed in, not after the fact.
   *
   * Saving a new address revokes every session the account holds, which is a
   * consequence the administrator has to be told about *before* they commit to
   * it — most of all when the account is their own and the next thing that
   * happens is their own sign-out.
   */
  const emailChanged = editing !== null && normalizedEmail !== editing.email;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.admin.all });
  };

  /**
   * Updates one field and retires the error attached to it.
   *
   * "Someone already uses that email" describes the value that was *submitted*,
   * not the one now in the box. Leaving it under a field the administrator has
   * since corrected reads as a rejection of the correction — and for the email it
   * also hides the sign-out warning behind a message that no longer applies.
   */
  const setField = <K extends keyof FormState>(name: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [name]: value }));
    setErrors((current) => {
      if (current[name] === undefined) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  /**
   * The one place a mutation failure becomes field-level feedback.
   *
   * `EMAIL_TAKEN` and `EMPLOYEE_CODE_TAKEN` arrive as 409s with no `details`
   * array, so they have to be routed onto their fields by code — otherwise the
   * one thing the admin must fix is announced somewhere they are not looking.
   */
  const applyError = (error: unknown) => {
    if (isErrorCode(error, ErrorCode.EMAIL_TAKEN)) {
      setView('form');
      setErrors({ email: 'Someone in this organization already uses that email.' });
      return;
    }
    if (isErrorCode(error, ErrorCode.EMPLOYEE_CODE_TAKEN)) {
      setView('form');
      setErrors({ employeeCode: 'That employee code is already taken.' });
      return;
    }
    if (isErrorCode(error, ErrorCode.LAST_ADMIN)) {
      setFormError(
        sentences(
          toDisplayMessage(error),
          'Promote somebody else to administrator first, then try again',
        ),
      );
      return;
    }
    if (isErrorCode(error, ErrorCode.VALIDATION_FAILED)) {
      const detail = fieldErrors(error);
      if (Object.keys(detail).length > 0) {
        setView('form');
        setErrors(detail);
        return;
      }
    }
    setFormError(
      isOffline(error)
        ? 'Nothing was changed — the server could not be reached.'
        : toDisplayMessage(error),
    );
  };

  const create = useMutation({
    mutationFn: (body: CreateUserRequest) => adminApi.createUser(body),
    onSuccess: (created) => {
      toast.show({ tone: 'success', title: `${created.fullName} added` });
      invalidate();
      onClose();
    },
    onError: applyError,
  });

  const update = useMutation({
    mutationFn: (input: { id: string; body: UpdateUserRequest }) =>
      adminApi.updateUser(input.id, input.body),
    onSuccess: (updated, input) => {
      toast.show({
        tone: 'success',
        title: `${updated.fullName} updated`,
        // The sign-out is the part of an address change that has consequences
        // for somebody who is not in the room, so it is confirmed rather than
        // left to be discovered when their phone stops working.
        ...(input.body.email === undefined
          ? {}
          : {
              description: `They now sign in as ${updated.email}, and have been signed out everywhere.`,
              duration: 7000,
            }),
      });
      invalidate();
      onClose();
    },
    onError: applyError,
  });

  const resetPassword = useMutation({
    mutationFn: (input: { id: string; password: string }) =>
      adminApi.resetUserPassword(input.id, input.password),
    onSuccess: () => {
      toast.show({
        tone: 'success',
        title: 'Password reset',
        description: 'Their other devices have been signed out.',
        duration: 7000,
      });
      invalidate();
      onClose();
    },
    onError: applyError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => adminApi.deleteUser(id),
    onSuccess: () => {
      toast.show({
        tone: 'success',
        title: `${editing?.fullName ?? 'Person'} removed`,
        description: 'Their attendance history is kept.',
      });
      invalidate();
      onClose();
    },
    onError: (error) => {
      setView('menu');
      applyError(error);
    },
  });

  const busy = create.isPending || update.isPending || resetPassword.isPending || remove.isPending;

  const onSubmitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setErrors({});
    setFormError(null);

    const local: Record<string, string> = {};
    if (form.fullName.trim().length < 2) local['fullName'] = 'Enter at least 2 characters.';
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) {
      local['email'] = 'Enter a valid email address.';
    }
    if (!editing) {
      if (form.password.length < PASSWORD_MIN_LENGTH) {
        local['password'] = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
      } else if (!/[a-zA-Z]/.test(form.password) || !/[0-9]/.test(form.password)) {
        local['password'] = 'Include at least one letter and one number.';
      }
    }
    if (form.employeeCode && !/^[A-Za-z0-9._-]*$/.test(form.employeeCode.trim())) {
      local['employeeCode'] = 'Letters, numbers, dot, dash and underscore only.';
    }
    if (Object.keys(local).length > 0) {
      setErrors(local);
      return;
    }

    const code = form.employeeCode.trim();

    if (!editing) {
      create.mutate({
        email: form.email.trim(),
        password: form.password,
        fullName: form.fullName.trim(),
        // Explicit `undefined` rather than an omitted key: the contract types
        // the property as required-but-possibly-undefined, and an empty string
        // would be sent as a code for somebody who simply has none.
        employeeCode: code === '' ? undefined : code,
        role: form.role,
      });
      return;
    }

    const body: UpdateUserRequest = {};
    // Compared in the server's canonical form, not as typed. The contract
    // lowercases and trims, so re-saving `Ali@X.com` over `ali@x.com` is not a
    // change — and sending it as one would revoke the person's sessions for a
    // difference nobody made.
    if (normalizedEmail !== editing.email) body.email = normalizedEmail;
    if (form.fullName.trim() !== editing.fullName) body.fullName = form.fullName.trim();
    if (code !== (editing.employeeCode ?? '')) body.employeeCode = code === '' ? null : code;
    if (form.role !== editing.role) body.role = form.role;
    if (form.status !== editing.status) body.status = form.status;

    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    update.mutate({ id: editing.id, body });
  };

  const onSubmitPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !editing) return;
    setErrors({});
    setFormError(null);

    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      setErrors({ newPassword: `Use at least ${PASSWORD_MIN_LENGTH} characters.` });
      return;
    }
    if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setErrors({ newPassword: 'Include at least one letter and one number.' });
      return;
    }
    resetPassword.mutate({ id: editing.id, password: newPassword });
  };

  const toggleStatus = () => {
    if (!editing || busy) return;
    setFormError(null);
    update.mutate({
      id: editing.id,
      body: {
        status: editing.status === UserStatus.ACTIVE ? UserStatus.SUSPENDED : UserStatus.ACTIVE,
      },
    });
  };

  const title =
    view === 'form'
      ? editing
        ? 'Edit person'
        : 'Add a person'
      : view === 'password'
        ? 'Reset password'
        : view === 'remove'
          ? 'Remove from organization'
          : (editing?.fullName ?? 'Person');

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      description={
        view === 'menu' ? editing?.email : view === 'remove' ? undefined : editing?.email
      }
      dismissible={view !== 'remove'}
      footer={footerFor()}
    >
      {formError ? <Banner tone="danger" title={formError} /> : null}

      {view === 'menu' && editing ? (
        <div className={styles.form}>
          <div className={styles.checkboxRow}>
            <Avatar name={editing.fullName} size="md" />
            <div className={styles.checkboxLabel}>
              <span className={styles.checkboxTitle}>{editing.fullName}</span>
              <span className={styles.checkboxHint}>
                {editing.employeeCode ? `${editing.employeeCode} · ` : ''}
                {editing.role === Role.ADMIN ? 'Administrator' : 'Member'} ·{' '}
                {editing.status === UserStatus.ACTIVE ? 'Active' : 'Suspended'}
              </span>
            </div>
          </div>

          <Button variant="secondary" fullWidth onClick={() => setView('form')} disabled={busy}>
            Edit details
          </Button>
          <Button
            variant="secondary"
            fullWidth
            iconStart={<LockIcon size="1.05rem" />}
            onClick={() => setView('password')}
            disabled={busy}
          >
            Reset password
          </Button>
          <Button
            variant="secondary"
            fullWidth
            loading={update.isPending}
            onClick={toggleStatus}
            disabled={busy}
          >
            {editing.status === UserStatus.ACTIVE ? 'Suspend access' : 'Reactivate access'}
          </Button>
          <Button
            variant="danger"
            fullWidth
            onClick={() => setView('remove')}
            disabled={busy || isSelf}
          >
            Remove from organization
          </Button>
          {isSelf ? (
            <Banner
              tone="neutral"
              title="This is your own account"
              description="You cannot remove yourself. Ask another administrator to do it."
            />
          ) : null}
        </div>
      ) : null}

      {view === 'form' ? (
        <form id="user-form" className={styles.form} onSubmit={onSubmitForm}>
          <Input
            label="Full name"
            required
            value={form.fullName}
            error={errors['fullName']}
            onChange={(event) => setField('fullName', event.target.value)}
            autoComplete="name"
            autoCapitalize="words"
          />

          <Input
            label="Email"
            type="email"
            required
            value={form.email}
            error={errors['email']}
            onChange={(event) => setField('email', event.target.value)}
            inputMode="email"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            hint={
              editing
                ? 'They sign in with this. Changing it signs them out everywhere.'
                : 'They sign in with this.'
            }
          />

          {/*
            Suppressed while the field is in error. Promising what saving will do
            underneath a message saying the save was refused is two claims about
            one input, and the one that has to be acted on is the error.
          */}
          {emailChanged && errors['email'] === undefined ? (
            <Banner
              tone="warning"
              title={isSelf ? 'You will be signed out' : 'They will be signed out'}
              description={
                isSelf
                  ? `Saving this signs you out on every device. Sign back in with ${normalizedEmail} and your current password.`
                  : `Saving this signs ${editing?.fullName ?? 'them'} out on every device. Tell them to sign in with ${normalizedEmail} and their existing password — it is unchanged.`
              }
            />
          ) : null}

          {editing ? null : (
            <Input
              label="Temporary password"
              type="password"
              required
              revealToggle
              value={form.password}
              error={errors['password']}
              onChange={(event) => setField('password', event.target.value)}
              autoComplete="new-password"
              hint={`At least ${PASSWORD_MIN_LENGTH} characters, with a letter and a number.`}
            />
          )}

          <Input
            label="Employee code"
            optionalText="Optional"
            value={form.employeeCode}
            error={errors['employeeCode']}
            onChange={(event) => setField('employeeCode', event.target.value)}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            hint="Appears in the exported attendance sheet."
          />

          <Select
            label="Role"
            value={form.role}
            error={errors['role']}
            onChange={(event) => setField('role', event.target.value as Role)}
            hint={
              form.role === Role.ADMIN
                ? 'Administrators manage people, sites and exports.'
                : 'Members can only check in and out.'
            }
          >
            <option value={Role.MEMBER}>Member</option>
            <option value={Role.ADMIN}>Administrator</option>
          </Select>

          {editing ? (
            <Select
              label="Status"
              value={form.status}
              error={errors['status']}
              onChange={(event) => setField('status', event.target.value as UserStatus)}
              hint="A suspended person cannot sign in or punch."
            >
              <option value={UserStatus.ACTIVE}>Active</option>
              <option value={UserStatus.SUSPENDED}>Suspended</option>
            </Select>
          ) : null}
        </form>
      ) : null}

      {view === 'password' && editing ? (
        <form id="reset-password-form" className={styles.form} onSubmit={onSubmitPassword}>
          <Banner
            tone="neutral"
            title={`Set a new password for ${editing.fullName}`}
            description="Every device they are signed in on will be signed out. Tell them the new password over a channel they already trust."
          />
          <Input
            label="New password"
            type="password"
            required
            revealToggle
            value={newPassword}
            error={errors['newPassword']}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            hint={`At least ${PASSWORD_MIN_LENGTH} characters, with a letter and a number.`}
          />
        </form>
      ) : null}

      {view === 'remove' && editing ? (
        <div className={styles.form}>
          <Banner
            tone="danger"
            title={`Remove ${editing.fullName}?`}
            description="They lose access immediately and disappear from the directory. Their attendance history is kept, so past exports stay complete."
          />
          <div className={styles.checkboxRow}>
            <Avatar name={editing.fullName} size="md" />
            <div className={styles.checkboxLabel}>
              <span className={styles.checkboxTitle}>{editing.email}</span>
              <span className={styles.checkboxHint}>
                <Badge tone={editing.role === Role.ADMIN ? 'accent' : 'neutral'} size="sm">
                  {editing.role === Role.ADMIN ? 'Administrator' : 'Member'}
                </Badge>
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </Sheet>
  );

  function footerFor() {
    if (view === 'form') {
      return (
        <>
          <Button
            variant="secondary"
            onClick={() => (editing ? setView('menu') : onClose())}
            disabled={busy}
          >
            {editing ? 'Back' : 'Cancel'}
          </Button>
          <Button
            type="submit"
            form="user-form"
            loading={create.isPending || update.isPending}
            disabled={busy && !(create.isPending || update.isPending)}
          >
            {editing ? 'Save changes' : 'Add person'}
          </Button>
        </>
      );
    }
    if (view === 'password') {
      return (
        <>
          <Button variant="secondary" onClick={() => setView('menu')} disabled={busy}>
            Back
          </Button>
          <Button type="submit" form="reset-password-form" loading={resetPassword.isPending}>
            Reset password
          </Button>
        </>
      );
    }
    if (view === 'remove') {
      return (
        <>
          <Button variant="secondary" onClick={() => setView('menu')} disabled={busy}>
            Keep them
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => editing && remove.mutate(editing.id)}
          >
            Remove
          </Button>
        </>
      );
    }
    return (
      <Button variant="secondary" fullWidth onClick={onClose} disabled={busy}>
        Close
      </Button>
    );
  }
}
