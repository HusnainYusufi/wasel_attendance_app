import { z } from 'zod';
import { authUserSchema } from './auth.js';
import { emailSchema, fullNameSchema } from './common.js';
import { PASSWORD_MAX_LENGTH } from './constants.js';

/**
 * Self-service account management: the profile every signed-in user owns,
 * regardless of role.
 *
 * The admin module edits *other* people; this edits yourself. The two are not
 * the same operation even though they touch the same columns — see
 * {@link updateProfileRequestSchema} for the step-up the self-service path
 * carries and the admin path does not.
 */

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------

/**
 * The image types the server will store.
 *
 * SVG is **deliberately absent**. An SVG is a document, not a bitmap: it can
 * carry `<script>`, `<foreignObject>` and external references, so an SVG avatar
 * served from the API's origin is a stored-XSS primitive aimed at every
 * colleague who opens the directory. There is no way to accept SVG and keep that
 * property, and no user need for it — a profile picture comes from a camera.
 *
 * Everything else the phone can open (HEIC, AVIF, GIF, BMP…) is handled by
 * re-encoding on the *client* before upload — see {@link AVATAR_MAX_EDGE_PX} —
 * so the server never needs a native image decoder and never stores a format
 * some browser cannot render.
 */
export const AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number];

export const avatarMimeTypeSchema = z.enum(AVATAR_MIME_TYPES);

/**
 * Hard ceiling on a stored avatar, bytes.
 *
 * A 512 px JPEG at q0.85 is 30–80 KB, so 2 MiB is roughly 25× headroom: enough
 * that no legitimate upload is ever refused, small enough that the row stays
 * cheap to read and a hostile client cannot make the server buffer megabytes.
 * The client re-encodes below this before it uploads; the server enforces it
 * because a client-side limit is a suggestion.
 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Longest edge of a re-encoded avatar, pixels.
 *
 * Sized for the largest place an avatar is drawn (a 4 rem plate) at 3× device
 * pixel ratio, with room to spare. Storing the camera's original 12 MP frame
 * would put ~4 MB in a row that is read to draw a 24 px circle.
 */
export const AVATAR_MAX_EDGE_PX = 512;

/** What the client re-encodes to. Universally renderable, and it has no alpha. */
export const AVATAR_ENCODE_MIME_TYPE: AvatarMimeType = 'image/jpeg';

/** JPEG quality for the re-encode. Visually lossless at this size. */
export const AVATAR_ENCODE_QUALITY = 0.85;

/**
 * An avatar's metadata, without its bytes.
 *
 * The bytes are fetched separately from `GET /users/:id/avatar` so that the
 * profile response — which the mobile client holds in memory and writes to
 * device storage — stays a few hundred bytes of JSON.
 */
export const avatarSummarySchema = z.object({
  mimeType: avatarMimeTypeSchema,
  byteSize: z.number().int().positive(),
  /**
   * When the bytes last changed. The client keys its image cache on this, and
   * the server derives the `ETag` and `Last-Modified` validators from it, so a
   * replaced avatar cannot be served — or displayed — stale.
   */
  updatedAt: z.string(),
});
export type AvatarSummary = z.infer<typeof avatarSummarySchema>;

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * The caller's own account.
 *
 * Built by extending {@link authUserSchema} rather than restating its fields:
 * `GET /auth/me` and `GET /api/v1/profile` describe the same principal, and two
 * independent declarations of one shape drift the first time a field is added to
 * only one of them. The extension is the avatar, which the authentication
 * response has no reason to carry.
 */
export const profileSchema = authUserSchema.extend({
  avatar: avatarSummarySchema.nullable(),
});
export type ProfileDto = z.infer<typeof profileSchema>;

/**
 * Edit your own name and sign-in address.
 *
 * **Changing the email requires the current password.** The rule is expressed
 * here, in the contract, so the client cannot ship a form that omits the field
 * and the server cannot forget to demand it.
 *
 * The reasoning is worth stating because the admin equivalent
 * (`updateUserRequestSchema`) deliberately does *not* carry this field:
 *
 *  * An administrator editing an employee is a **second principal** acting under
 *    a mandate, already proven to hold ADMIN, and every such edit lands in
 *    `audit_logs` under their name. There is somebody else to notice.
 *  * Self-service has no second party. The actor and the subject are the same
 *    person, so the only evidence that the edit was legitimate is the session it
 *    arrived on — and on a phone that session is a long-lived refresh token
 *    behind whatever lock screen the user happens to use.
 *
 * That is the attack this field exists for: someone with a *borrowed unlocked
 * phone* re-points the account at an address they control. Email is half of the
 * credential pair, so from there every recovery path in the product — an
 * administrator resetting the password to the "employee's" address, any future
 * forgot-password flow — leads to a full takeover, and the real owner cannot even
 * sign in to notice. Requiring the password converts "held the device for a
 * minute" into "knows the password", which is exactly the gap the attack walks
 * through. It costs a legitimate user one field on a form they will use once.
 *
 * A name change does not require it: a wrong display name is embarrassing, not a
 * credential.
 */
export const updateProfileRequestSchema = z
  .object({
    fullName: fullNameSchema.optional(),
    /**
     * The same {@link emailSchema} used everywhere else, so the trimmed-lowercase
     * normalisation applies here too. Bypassing it would let a self-service
     * change to `Ali@x.com` slip past a `(organizationId, email)` index that
     * already holds `ali@x.com` — two accounts, one human, one of which can never
     * sign in.
     */
    email: emailSchema.optional(),
    /**
     * Bounded, never validated against the password *policy*: this is an existing
     * credential, and applying the creation rules to it would reject accounts
     * whose password predates the current policy.
     */
    currentPassword: z
      .string()
      .min(1, 'Enter your current password')
      .max(PASSWORD_MAX_LENGTH)
      .optional(),
  })
  .refine((v) => v.fullName !== undefined || v.email !== undefined, {
    message: 'Provide at least one field to update',
    path: ['fullName'],
  })
  .refine((v) => v.email === undefined || v.currentPassword !== undefined, {
    message: 'Confirm your current password to change your email address',
    path: ['currentPassword'],
  });
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;
