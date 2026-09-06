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
  SegmentedControl,
  Sheet,
  useToast,
  type ThemePreference,
} from '../../design';
import { useTheme } from '../../design';
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

/**
 * Account, appearance and sign-out, reachable from the header of every screen.
 *
 * The change-password form lives in this same sheet rather than a second one
 * stacked on top: two open dialogs mean two focus traps competing for the same
 * document, and the one underneath wins on some browsers.
 */
export function AccountSheet({ open, onClose }: AccountSheetProps) {
  const { user, signOut } = useAuth();
  const { preference, setPreference } = useTheme();
  const toast = useToast();

  const [view, setView] = useState<'menu' | 'password'>('menu');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<PasswordFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

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

  const resetForm = () => {
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

  if (!user) return null;

  const isPasswordView = view === 'password';

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={isPasswordView ? 'Change password' : 'Your account'}
      description={
        isPasswordView
          ? 'Changing your password signs you out everywhere.'
          : `${user.organizationName} · ${user.timezone}`
      }
      footer={
        isPasswordView ? (
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setView('menu');
                resetForm();
              }}
              disabled={changePassword.isPending}
            >
              Back
            </Button>
            <Button
              type="submit"
              form="change-password-form"
              loading={changePassword.isPending}
              iconStart={<LockIcon size="1.05rem" />}
            >
              Change password
            </Button>
          </>
        ) : (
          <Button variant="danger" fullWidth loading={signingOut} onClick={onSignOut}>
            Sign out
          </Button>
        )
      }
    >
      {isPasswordView ? (
        <form id="change-password-form" className={styles.form} onSubmit={onSubmitPassword}>
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
      ) : (
        <div className={styles.stack}>
          <div className={styles.identity}>
            <Avatar name={user.fullName} size="lg" />
            <div className={styles.identityText}>
              <span className={styles.name}>{user.fullName}</span>
              <span className={styles.email}>{user.email}</span>
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
            <span className={styles.sectionTitle}>Security</span>
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
