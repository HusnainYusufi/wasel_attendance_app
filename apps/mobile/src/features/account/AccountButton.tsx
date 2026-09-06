import { useState } from 'react';
import { useAuth } from '../../auth';
import { Avatar, IconButton, UsersIcon } from '../../design';
import { AccountSheet } from './AccountSheet';

/**
 * The global account affordance.
 *
 * It sits in the `action` slot of every signed-in screen, always in the same
 * top-trailing position, so sign-out and change-password are one tap from
 * anywhere rather than buried behind a tab the user has to know about.
 */
export function AccountButton() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  return (
    <>
      <IconButton
        size="lg"
        label={user ? `Account: ${user.fullName}` : 'Account'}
        icon={user ? <Avatar name={user.fullName} size="sm" /> : <UsersIcon size="1.25rem" />}
        onClick={() => setOpen(true)}
      />
      <AccountSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
