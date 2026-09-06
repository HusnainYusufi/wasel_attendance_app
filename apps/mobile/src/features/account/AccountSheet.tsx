import { useMutation } from '@tanstack/react-query';
import { ErrorCode, PASSWORD_MIN_LENGTH, Role } from '@wasel/contracts';
import { useState, type FormEvent } from 'react';
import { authApi, fieldErrors, isErrorCode, isOffline, toDisplayMessage } from '../../api';
import { useAuth } from '../../auth';
import { Banner } from '../../components/Banner';
import {
  Avatar,
  Badge,
  Button,
  Input,
  LockIcon,
  MailIcon,
  SegmentedControl,
  Sheet,
  useToast,
  type ThemePreference,
} from '../../design';
import { useTheme } from '../../design';
import { RemindersSetting } from '../notifications';
import { AvatarPicker } from './AvatarPicker';
import { useAvatarObjectUrl, useProfile } from './useProfile';
import { useProfileEditor } from './useProfileEditor';
import styles from './AccountSheet.module.css';

export interface AccountSheetProps {
  open: boolean;
  onClose: () => void;
}

const THEME_OPTIONS = [
  { value: 'system' as const, label: 'System' },
  { value: 'light' as const, label: 'Light' },
  { value: 'dark' as const, label: 'Dark' },
];

const PROFILE_FORM_ID = 'edit-profile-form';
const PASSWORD_FORM_ID = 'change-password-form';

type View = 'menu' | 'profile' | 'password';

interface PasswordFieldErrors {
  currentPassword?: string;
  newPassword?: string;
  confirmPassword?: string;
}

/**
 * Mirrors `passwordSchema` from the contract so the obvious mistakes are caught
 * without a round trip. It deliberately does not try to be exhaustive — the
 * server remains the authority, and its messages are wired back onto the fields.
 */
function validateNewPassword(value: string): string | undefined {
  if (value.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (!/[a-zA-Z]/.test(value)) return 'Include at least one letter.';
  if (!/[0-9]/.test(value)) return 'Include at least one number.';
  return undefined;
}

const TITLES: Record<View, string> = {
  menu: 'Your account',
  profile: 'Edit profile',
  password: 'Change password',
};

/**
 * Account, appearance and sign-out, reachable from the header of every screen.
 *
 * All three views live in this one sheet rather than stacking dialogs: two open
 * dialogs mean two focus traps competing for the same document, and the one
 * underneath wins on some browsers.
 */
export function AccountSheet({ open, onClose }: AccountSheetProps) {
  const { user, signOut } = useAuth();
  const { preference, setPreference } = useTheme();
  const toast = useToast();

  const { data: profile } = useProfile();
  const avatarUrl = useAvatarObjectUrl(profile?.id, profile?.avatar?.updatedAt);

  const [view, setView] = useState<View>('menu');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<PasswordFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const editor = useProfileEditor(profile, () => setView('menu'));

  /**
   * Reset on the *opening* edge, adjusted during render rather than in an
   * effect: an effect would leave one painted frame holding the password the
   * user got wrong last time, and resetting on the closing edge would blank the
   * sheet mid-way through its exit animation.
   */
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setView('menu');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setErrors({});
      setFormError(null);
    }
  }

  const resetPasswordForm = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setErrors({});
    setFormError(null);
  };

  const changePassword = useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      authApi.changePassword(input),
    onSuccess: () => {
      // The server revokes every session on a password change, so the tokens in
      // hand are already dead. Signing out deliberately is honest; letting the
      // next request 401 would look like a random ejection.
      toast.show({
        tone: 'success',
        title: 'Password changed',
        description: 'For security, all your devices were signed out. Sign in again to continue.',
        duration: 8000,
      });
      onClose();
      void signOut();
    },
    onError: (error: unknown) => {
      if (isErrorCode(error, ErrorCode.INVALID_CREDENTIALS)) {
        setErrors({ currentPassword: 'That is not your current password.' });
        return;
      }
      if (isErrorCode(error, ErrorCode.VALIDATION_FAILED)) {
        const detail = fieldErrors(error);
        const mapped: PasswordFieldErrors = {};
        if (detail['currentPassword']) mapped.currentPassword = detail['currentPassword'];
        if (detail['newPassword']) mapped.newPassword = detail['newPassword'];
        if (Object.keys(mapped).length > 0) {
          setErrors(mapped);
          return;
        }
      }
      setFormError(
        isOffline(error)
          ? 'Your password was not changed — the server could not be reached.'
          : toDisplayMessage(error),
      );
    },
  });

  const onSubmitPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (changePassword.isPending) return;

    setFormError(null);
    const next: PasswordFieldErrors = {};
    if (currentPassword.length === 0) next.currentPassword = 'Enter your current password.';
    const policy = validateNewPassword(newPassword);
    if (policy) next.newPassword = policy;
    else if (newPassword === currentPassword) {
      next.newPassword = 'Choose a password different from your current one.';
    }
    if (confirmPassword !== newPassword) next.confirmPassword = 'The two passwords do not match.';

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    changePassword.mutate({ currentPassword, newPassword });
  };

  const onSignOut = () => {
    if (signingOut) return;
    setSigningOut(true);
    onClose();
    void signOut().finally(() => setSigningOut(false));
  };

  const openProfile = () => {
    // Seeded from the profile that is loaded *now*, not from whatever the hook
    // saw on its first render — the sheet is usually mounted before the query
    // resolves.
    editor.reset();
    setView('profile');
  };

  if (!user) return null;

  const displayName = profile?.fullName ?? user.fullName;
  const description =
    view === 'password'
      ? 'Changing your password signs you out everywhere.'
      : view === 'profile'
        ? 'Your picture, name and sign-in address.'
        : `${user.organizationName} · ${user.timezone}`;

  const footer =
    view === 'password' ? (
      <>
        <Button
          variant="secondary"
          onClick={() => {
            setView('menu');
            resetPasswordForm();
          }}
          disabled={changePassword.isPending}
        >
          Back
        </Button>
        <Button
          type="submit"
          form={PASSWORD_FORM_ID}
          loading={changePassword.isPending}
          iconStart={<LockIcon size="1.05rem" />}
        >
          Change password
        </Button>
      </>
    ) : view === 'profile' ? (
      <>
        <Button
          variant="secondary"
          onClick={() => setView('menu')}
          disabled={editor.saving || editor.avatarBusy}
        >
          Back
        </Button>
        <Button type="submit" form={PROFILE_FORM_ID} loading={editor.saving}>
          Save changes
        </Button>
      </>
    ) : (
      <Button variant="danger" fullWidth loading={signingOut} onClick={onSignOut}>
        Sign out
      </Button>
    );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={TITLES[view]}
      description={description}
      footer={footer}
    >
      {view === 'password' ? (
        <form id={PASSWORD_FORM_ID} className={styles.form} onSubmit={onSubmitPassword}>
          {formError ? <Banner tone="danger" title={formError} /> : null}

          <Input
            label="Current password"
            type="password"
            revealToggle
            autoComplete="current-password"
            required
            value={currentPassword}
            error={errors.currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
          <Input
            label="New password"
            type="password"
            revealToggle
            autoComplete="new-password"
            required
            hint={`At least ${PASSWORD_MIN_LENGTH} characters, with a letter and a number.`}
            value={newPassword}
            error={errors.newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <Input
            label="Confirm new password"
            type="password"
            revealToggle
            autoComplete="new-password"
            required
            value={confirmPassword}
            error={errors.confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </form>
      ) : view === 'profile' ? (
        <form id={PROFILE_FORM_ID} className={styles.form} onSubmit={editor.submit}>
          {editor.formError ? <Banner tone="danger" title={editor.formError} /> : null}

          <AvatarPicker
            name={displayName}
            src={avatarUrl}
            busy={editor.avatarBusy}
            onPick={editor.pickAvatar}
            onRemove={editor.removeAvatar}
          />

          <Input
            label="Full name"
            autoComplete="name"
            required
            value={editor.fullName}
            error={editor.errors.fullName}
            onChange={(event) => editor.setFullName(event.target.value)}
          />
          <Input
            label="Email address"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            iconStart={<MailIcon size="1.05rem" />}
            hint="This is what you sign in with."
            value={editor.email}
            error={editor.errors.email}
            onChange={(event) => editor.setEmail(event.target.value)}
          />

          {editor.emailChanged ? (
            <>
              {/* Shown only once the address actually differs. Asking for a
                  password up front on a form whose usual use is fixing a name
                  would read as a demand for no reason. */}
              <Banner
                tone="warning"
                title="Changing your email signs you out everywhere"
                description="Confirm your password, then sign in again with the new address."
              />
              <Input
                label="Current password"
                type="password"
                revealToggle
                autoComplete="current-password"
                required
                value={editor.currentPassword}
                error={editor.errors.currentPassword}
                onChange={(event) => editor.setCurrentPassword(event.target.value)}
              />
            </>
          ) : null}
        </form>
      ) : (
        <div className={styles.stack}>
          <div className={styles.identity}>
            <Avatar name={displayName} src={avatarUrl} size="lg" />
            <div className={styles.identityText}>
              <span className={styles.name}>{displayName}</span>
              <span className={styles.email}>{profile?.email ?? user.email}</span>
            </div>
          </div>

          <div className={styles.badges}>
            <Badge tone={user.role === Role.ADMIN ? 'accent' : 'neutral'}>
              {user.role === Role.ADMIN ? 'Administrator' : 'Member'}
            </Badge>
            {user.employeeCode ? <Badge tone="neutral">Code {user.employeeCode}</Badge> : null}
          </div>

          <div className={styles.section}>
            <span className={styles.sectionTitle}>Organization</span>
            <dl className={styles.meta}>
              <dt className={styles.metaKey}>Name</dt>
              <dd className={styles.metaValue}>{user.organizationName}</dd>
              <dt className={styles.metaKey}>Timezone</dt>
              <dd className={styles.metaValue}>{user.timezone}</dd>
            </dl>
          </div>

          {/* Owned by the notifications feature: it manages its own state and
              renders its own section, so the switch and the permission it
              depends on stay described in one place. */}
          <RemindersSetting timezone={user.timezone} />

          <div className={styles.section}>
            <span className={styles.sectionTitle}>Appearance</span>
            <SegmentedControl<ThemePreference>
              label="Theme"
              fullWidth
              options={THEME_OPTIONS}
              value={preference}
              onChange={setPreference}
            />
          </div>

          <div className={styles.section}>
            <span className={styles.sectionTitle}>Account</span>
            <Button variant="secondary" fullWidth disabled={!profile} onClick={openProfile}>
              Edit profile
            </Button>
            <Button
              variant="secondary"
              fullWidth
              iconStart={<LockIcon size="1.05rem" />}
              onClick={() => setView('password')}
            >
              Change password
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
