import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ErrorCode, type AuthUser, type ProfileDto } from '@wasel/contracts';
import { useCallback, useState, type FormEvent } from 'react';
import {
  fieldErrors,
  isErrorCode,
  isOffline,
  profileApi,
  queryKeys,
  toDisplayMessage,
} from '../../api';
import { useAuth } from '../../auth';
import { useToast } from '../../design';
import { ImageTooLargeError, UnreadableImageError, encodeAvatar } from './avatar-encode';

export interface ProfileFieldErrors {
  fullName?: string;
  email?: string;
  currentPassword?: string;
}

export interface ProfileEditor {
  fullName: string;
  email: string;
  currentPassword: string;
  setFullName: (value: string) => void;
  setEmail: (value: string) => void;
  setCurrentPassword: (value: string) => void;
  /** True once the typed address differs from the stored one — reveals the step-up field. */
  emailChanged: boolean;
  errors: ProfileFieldErrors;
  formError: string | null;
  saving: boolean;
  avatarBusy: boolean;
  submit: (event: FormEvent<HTMLFormElement>) => void;
  pickAvatar: (file: File) => void;
  removeAvatar: () => void;
  reset: () => void;
}

/** `ProfileDto` is `AuthUser` plus the avatar; the session object keeps the former. */
function toAuthUser(profile: ProfileDto): AuthUser {
  const { avatar: _avatar, ...user } = profile;
  return user;
}

const normalise = (value: string): string => value.trim().toLowerCase();

/**
 * Form state, validation and mutations for the account editor.
 *
 * Lives in a hook rather than in `AccountSheet` so the sheet stays a layout —
 * three views and a footer — instead of also being the place where the
 * email-change sign-out rule is implemented.
 */
export function useProfileEditor(
  profile: ProfileDto | undefined,
  onDone: () => void,
): ProfileEditor {
  const { updateUser, signOut } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [fullName, setFullName] = useState(profile?.fullName ?? '');
  const [email, setEmail] = useState(profile?.email ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [errors, setErrors] = useState<ProfileFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [encoding, setEncoding] = useState(false);

  const emailChanged = profile !== undefined && normalise(email) !== normalise(profile.email);

  const reset = useCallback(() => {
    setFullName(profile?.fullName ?? '');
    setEmail(profile?.email ?? '');
    setCurrentPassword('');
    setErrors({});
    setFormError(null);
  }, [profile]);

  /**
   * Only the profile document, never the avatar query beneath it.
   *
   * The avatar is keyed on its own `updatedAt`, so it never needs invalidating:
   * a new picture is a *new key* and a removed one disables the query. Sweeping
   * the whole `profile` tree instead re-runs the avatar fetch for an image that
   * has just been deleted — a guaranteed 404 in the console after every removal,
   * and the kind of benign-but-alarming noise that trains people to ignore real
   * errors.
   */
  const invalidateProfile = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.profile.self() }),
    [queryClient],
  );

  const applyFailure = useCallback((error: unknown, offlineMessage: string) => {
    if (isErrorCode(error, ErrorCode.EMAIL_TAKEN)) {
      setErrors({ email: 'That email address is already in use.' });
      return;
    }
    if (isErrorCode(error, ErrorCode.INVALID_CREDENTIALS)) {
      setErrors({ currentPassword: 'That is not your current password.' });
      return;
    }
    if (isErrorCode(error, ErrorCode.VALIDATION_FAILED)) {
      const detail = fieldErrors(error);
      const mapped: ProfileFieldErrors = {};
      if (detail['fullName']) mapped.fullName = detail['fullName'];
      if (detail['email']) mapped.email = detail['email'];
      if (detail['currentPassword']) mapped.currentPassword = detail['currentPassword'];
      if (Object.keys(mapped).length > 0) {
        setErrors(mapped);
        return;
      }
    }
    setFormError(isOffline(error) ? offlineMessage : toDisplayMessage(error));
  }, []);

  const save = useMutation({
    mutationFn: (input: { fullName?: string; email?: string; currentPassword?: string }) =>
      profileApi.update(input),
    onSuccess: (updated, input) => {
      if (input.email !== undefined) {
        // The server revoked every session, this one included, so the tokens in
        // hand are already dead. Signing out deliberately — with an explanation
        // — is honest; letting the next request 401 would look like a random
        // ejection moments after a successful save.
        toast.show({
          tone: 'success',
          title: 'Email address updated',
          description:
            'For security, all your devices were signed out. Sign in with your new address.',
          duration: 8000,
        });
        onDone();
        void signOut();
        return;
      }

      updateUser(toAuthUser(updated));
      void invalidateProfile();
      toast.show({ tone: 'success', title: 'Profile updated' });
      onDone();
    },
    onError: (error: unknown) =>
      applyFailure(error, 'Your profile was not saved — the server could not be reached.'),
  });

  const uploadAvatar = useMutation({
    mutationFn: async (file: File) => {
      // Re-encoded here, not on the server: the device already has a decoder for
      // whatever it let the user pick, and this keeps HEIC and AVIF working
      // without an image library in the API.
      setEncoding(true);
      try {
        const encoded = await encodeAvatar(file);
        return await profileApi.uploadAvatar(encoded.blob, encoded.contentType);
      } finally {
        setEncoding(false);
      }
    },
    onSuccess: () => {
      void invalidateProfile();
      toast.show({ tone: 'success', title: 'Photo updated' });
    },
    onError: (error: unknown) => {
      if (error instanceof UnreadableImageError || error instanceof ImageTooLargeError) {
        setFormError(error.message);
        return;
      }
      applyFailure(error, 'Your photo was not uploaded — the server could not be reached.');
    },
  });

  const removeAvatar = useMutation({
    mutationFn: () => profileApi.removeAvatar(),
    onSuccess: () => {
      void invalidateProfile();
      toast.show({ tone: 'success', title: 'Photo removed' });
    },
    onError: (error: unknown) =>
      applyFailure(error, 'Your photo was not removed — the server could not be reached.'),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (save.isPending || profile === undefined) return;

    setFormError(null);
    const next: ProfileFieldErrors = {};
    const trimmedName = fullName.trim();
    if (trimmedName.length < 2) next.fullName = 'Enter at least 2 characters.';
    if (trimmedName.length > 120) next.fullName = 'Use at most 120 characters.';
    if (email.trim().length === 0) next.email = 'Enter your email address.';
    if (emailChanged && currentPassword.length === 0) {
      next.currentPassword = 'Confirm your password to change your email.';
    }

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const nameChanged = trimmedName !== profile.fullName;
    if (!nameChanged && !emailChanged) {
      onDone();
      return;
    }

    // Only what actually moved is sent. Submitting every field would demand a
    // password for a name-only edit, because the contract requires the step-up
    // whenever `email` is present at all.
    save.mutate({
      ...(nameChanged ? { fullName: trimmedName } : {}),
      ...(emailChanged ? { email: email.trim(), currentPassword } : {}),
    });
  };

  return {
    fullName,
    email,
    currentPassword,
    setFullName,
    setEmail,
    setCurrentPassword,
    emailChanged,
    errors,
    formError,
    saving: save.isPending,
    avatarBusy: encoding || uploadAvatar.isPending || removeAvatar.isPending,
    submit,
    pickAvatar: (file: File) => uploadAvatar.mutate(file),
    removeAvatar: () => removeAvatar.mutate(),
    reset,
  };
}
