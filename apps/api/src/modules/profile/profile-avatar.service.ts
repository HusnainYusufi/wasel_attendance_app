import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AVATAR_MAX_BYTES,
  AVATAR_MIME_TYPES,
  ErrorCode,
  type AvatarMimeType,
  type AvatarSummary,
} from '@wasel/contracts';
import type { Readable } from 'node:stream';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { AppException, Errors } from '../../common/errors/app.exception.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { ClientInfo } from '../auth/client-context.js';
import {
  imageFormatLabel,
  isAvatarMimeType,
  parseContentLength,
  parseImageContentType,
  sniffImageFormat,
  ImageFormat,
} from './avatar-image.js';
import { ProfileAuditService } from './profile-audit.service.js';
import { ProfileAuditAction } from './profile.constants.js';
import { PayloadTooLargeError, readBoundedBody } from './raw-body.js';

/** The field an avatar failure is attached to, so the client can mark the control. */
const AVATAR_FIELD = 'avatar';

const ACCEPTED_LIST = AVATAR_MIME_TYPES.join(', ');

/** Metadata for a stored avatar, without the bytes. Enough to answer a 304. */
export interface AvatarMetadata {
  mimeType: AvatarMimeType;
  byteSize: number;
  updatedAt: Date;
}

export interface AvatarContent extends AvatarMetadata {
  data: Buffer;
}

/**
 * A rejected upload.
 *
 * Every one of these carries `details` pointing at the same field, so the mobile
 * client can mark the picker without switching on the status — and a status that
 * is accurate on its own terms: 415 for a type we will not take, 413 for a body
 * over the cap, 400 for bytes that contradict their own declaration.
 */
function rejectUpload(status: number, message: string): AppException {
  return new AppException(status, ErrorCode.VALIDATION_FAILED, message, [
    { path: AVATAR_FIELD, message },
  ]);
}

@Injectable()
export class ProfileAvatarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ProfileAuditService,
  ) {}

  /**
   * Stores (or replaces) the caller's own avatar.
   *
   * The validation order is the security-relevant part, and it is cheapest-first
   * on purpose — each step refuses work the next one would otherwise have to do:
   *
   *  1. **Declared type**, from a header, before a byte of body is read. An
   *     unacceptable type costs nothing to refuse.
   *  2. **Declared length**, before a byte of body is read. A caller announcing
   *     10 MB is turned away without buffering any of it.
   *  3. **Actual length**, while reading, because step 2 is a claim. A chunked
   *     upload sends no `Content-Length` at all.
   *  4. **Actual format**, from the magic bytes, because step 1 is *also* a
   *     claim — and the one that matters most. The stored `mimeType` is what the
   *     `GET` route later hands back as `Content-Type`, so trusting the header
   *     would let a caller choose the type their bytes are served under. That is
   *     the whole stored-XSS shape: upload markup, declare it `image/png`, get it
   *     served from the API's own origin.
   */
  async replace(
    auth: AuthContext,
    headers: { contentType?: string | string[]; contentLength?: string | string[] },
    stream: Readable,
    client: ClientInfo,
  ): Promise<AvatarSummary> {
    const declared = this.assertDeclaredType(headers.contentType);
    this.assertDeclaredLength(headers.contentLength);

    const data = await this.readBody(stream);
    this.assertBytesMatchDeclaration(data, declared);

    const stored = await this.prisma.userAvatar.upsert({
      // Keyed on the caller's own id from the token — never from the request —
      // so this route cannot be pointed at another account.
      where: { userId: auth.userId },
      create: { userId: auth.userId, mimeType: declared, byteSize: data.byteLength, data },
      update: { mimeType: declared, byteSize: data.byteLength, data },
      // `data` is deliberately not selected back: the caller just sent it, and
      // reading it again would double the bytes on the wire for no purpose.
      select: { mimeType: true, byteSize: true, updatedAt: true },
    });

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: ProfileAuditAction.AVATAR_UPDATED,
      metadata: { mimeType: declared, byteSize: stored.byteSize },
      client,
    });

    return {
      mimeType: declared,
      byteSize: stored.byteSize,
      updatedAt: stored.updatedAt.toISOString(),
    };
  }

  /** Removes the caller's own avatar. Idempotent: removing nothing is a success. */
  async remove(auth: AuthContext, client: ClientInfo): Promise<void> {
    // `deleteMany` rather than `delete`: a user with no avatar asking for it to
    // be gone has got what they wanted, and answering P2025 → 404 would make the
    // client show an error for an outcome it already agrees with.
    const { count } = await this.prisma.userAvatar.deleteMany({ where: { userId: auth.userId } });
    if (count === 0) return;

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: ProfileAuditAction.AVATAR_REMOVED,
      client,
    });
  }

  /**
   * An avatar's metadata, scoped to the caller's organization.
   *
   * The tenancy predicate sits on the *relation*, not on a separately-fetched
   * user row: `user: { organizationId }` compiles to a join, so there is no
   * window in which the avatar is read and the ownership check is skipped. An
   * avatar belonging to another tenant — or to a soft-deleted employee — is
   * indistinguishable from one that does not exist, which is the only answer
   * that does not confirm the account exists.
   */
  async metadata(auth: AuthContext, userId: string): Promise<AvatarMetadata | null> {
    const row = await this.prisma.userAvatar.findFirst({
      where: this.scope(auth, userId),
      select: { mimeType: true, byteSize: true, updatedAt: true },
    });
    return this.toMetadata(row);
  }

  /** The same row, with the bytes. Read only when a body is actually going out. */
  async content(auth: AuthContext, userId: string): Promise<AvatarContent | null> {
    const row = await this.prisma.userAvatar.findFirst({
      where: this.scope(auth, userId),
      select: { mimeType: true, byteSize: true, updatedAt: true, data: true },
    });
    const metadata = this.toMetadata(row);
    if (row === null || metadata === null) return null;
    return { ...metadata, data: Buffer.from(row.data) };
  }

  private scope(auth: AuthContext, userId: string): Prisma.UserAvatarWhereInput {
    return { userId, user: { organizationId: auth.organizationId, deletedAt: null } };
  }

  /**
   * A stored type outside the accepted set is treated as no avatar at all.
   *
   * Only this service writes that column and only after sniffing the bytes, so
   * this should be unreachable — but "unreachable" is exactly what makes a
   * restored backup or a manual data fix start serving a `Content-Type` this API
   * never validated, and the serving path must not be the first place that is
   * noticed.
   */
  private toMetadata(
    row: { mimeType: string; byteSize: number; updatedAt: Date } | null,
  ): AvatarMetadata | null {
    if (row === null || !isAvatarMimeType(row.mimeType)) return null;
    return { mimeType: row.mimeType, byteSize: row.byteSize, updatedAt: row.updatedAt };
  }

  // --- validation ----------------------------------------------------------

  private assertDeclaredType(header: string | string[] | undefined): AvatarMimeType {
    const declared = parseImageContentType(header);
    if (declared === null) {
      throw rejectUpload(
        415,
        `Send the image as the request body with a Content-Type of ${ACCEPTED_LIST}`,
      );
    }
    if (declared === ImageFormat.SVG) {
      // Named explicitly rather than folded into the generic refusal: an SVG is
      // the one rejection a user is likely to think is a bug, because every
      // other tool they use treats it as an image.
      throw rejectUpload(415, 'SVG images are not supported. Use a JPEG, PNG or WebP photo');
    }
    if (!isAvatarMimeType(declared)) {
      throw rejectUpload(415, `${declared} is not a supported image type. Use ${ACCEPTED_LIST}`);
    }
    return declared;
  }

  private assertDeclaredLength(header: string | string[] | undefined): void {
    const declared = parseContentLength(header);
    if (declared !== null && declared > AVATAR_MAX_BYTES) throw this.tooLarge();
  }

  private async readBody(stream: Readable): Promise<Buffer> {
    let data: Buffer;
    try {
      data = await readBoundedBody(stream, AVATAR_MAX_BYTES);
    } catch (error) {
      // Turned into the module's own envelope rather than left to reach the
      // global filter as an unhandled failure — which is how an oversized upload
      // becomes a bare 413, or worse a 500, with nothing a client can show.
      if (error instanceof PayloadTooLargeError) throw this.tooLarge();
      throw error;
    }
    if (data.byteLength === 0) throw rejectUpload(400, 'The request body was empty');
    return data;
  }

  private assertBytesMatchDeclaration(data: Buffer, declared: AvatarMimeType): void {
    const actual = sniffImageFormat(data);
    if (actual === declared) return;

    if (actual === ImageFormat.SVG) {
      throw rejectUpload(415, 'SVG images are not supported. Use a JPEG, PNG or WebP photo');
    }
    // States both halves of the contradiction. "That is not a JPEG" is useless
    // to somebody who renamed a PNG; "declared JPEG, is a PNG" is actionable.
    throw rejectUpload(
      400,
      `The file is ${imageFormatLabel(actual)}, not ${declared}. ` +
        'Re-save the image and try again',
    );
  }

  private tooLarge(): AppException {
    const megabytes = Math.round(AVATAR_MAX_BYTES / (1024 * 1024));
    return rejectUpload(
      413,
      `The image is too large. Profile pictures must be under ${megabytes} MB`,
    );
  }

  /** 404 for "no such avatar", "no such user" and "not your tenant" alike. */
  notFound(): AppException {
    return Errors.notFound('Avatar');
  }
}
