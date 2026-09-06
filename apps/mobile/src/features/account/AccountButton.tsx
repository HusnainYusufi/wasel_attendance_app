import { useState } from 'react';
import { useAuth } from '../../auth';
import { Avatar, IconButton, UsersIcon } from '../../design';
import { AccountSheet } from './AccountSheet';
import { useAvatarObjectUrl, useProfile } from './useProfile';

/**
 * The global account affordance.
 *
 * It sits in the `action` slot of every signed-in screen, always in the same
 * top-trailing position, so the profile, sign-out and change-password are one
 * tap from anywhere rather than buried behind a tab the user has to know about.
 *
 * It is also where a user's own picture proves it worked: the query is shared
 * with the sheet, so uploading a photo updates the button in the corner at the
 * same moment it updates the editor.
 */
export function AccountButton() {
  const { user } = useAuth();
  const { data: profile } = useProfile();
  const avatarUrl = useAvatarObjectUrl(profile?.id, profile?.avatar?.updatedAt);
  const [open, setOpen] = useState(false);

  const name = profile?.fullName ?? user?.fullName;

  return (
    <>
      <IconButton
        size="lg"
        label={name ? `Account: ${name}` : 'Account'}
        icon={
          name ? <Avatar name={name} src={avatarUrl} size="sm" /> : <UsersIcon size="1.25rem" />
        }
        onClick={() => setOpen(true)}
      />
      <AccountSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
