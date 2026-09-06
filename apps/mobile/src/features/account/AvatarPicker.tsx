import { AVATAR_MAX_EDGE_PX } from '@wasel/contracts';
import { useRef, type ChangeEvent } from 'react';
import { Avatar, Button, Spinner } from '../../design';
import styles from './AvatarPicker.module.css';

export interface AvatarPickerProps {
  name: string;
  src: string | null;
  busy: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
}

/**
 * Choose or clear a profile picture.
 *
 * `accept="image/*"` rather than the three types the server stores, and that is
 * deliberate: on Android this is what offers the camera alongside the gallery,
 * and the customer asked for "any format". Whatever comes back is decoded and
 * re-encoded to JPEG before it is uploaded — see `avatar-encode.ts` — so the
 * picker can afford to be generous while the wire stays narrow.
 *
 * A file input cannot be styled, so the real control is hidden and driven from a
 * `Button`. It stays in the DOM (rather than being created on demand) so the
 * click lands inside the same user gesture, which is what iOS requires.
 */
export function AvatarPicker({ name, src, busy, onPick, onRemove }: AvatarPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared unconditionally: without this, picking the same file twice in a
    // row fires no `change` event the second time, and a user retrying after a
    // failed upload would get no response at all.
    event.target.value = '';
    if (file) onPick(file);
  };

  return (
    <div className={styles.picker}>
      <div className={styles.plate}>
        <Avatar name={name} src={src} size="xl" />
        {busy ? (
          <span className={styles.busy} aria-hidden="true">
            <Spinner size="sm" />
          </span>
        ) : null}
      </div>

      <div className={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {src ? 'Change photo' : 'Add photo'}
        </Button>
        {src ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
            Remove
          </Button>
        ) : null}
        <p className={styles.hint}>
          Any image your phone can open. It is resized to {AVATAR_MAX_EDGE_PX}px before upload.
        </p>
      </div>

      <input
        ref={inputRef}
        className={styles.input}
        type="file"
        accept="image/*"
        // Not part of the form: the picture is uploaded the moment it is chosen,
        // so it must not be submitted with the name and email fields.
        aria-label="Choose a profile picture"
        tabIndex={-1}
        onChange={onChange}
      />
    </div>
  );
}
