import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiProduces, ApiResponse } from '@nestjs/swagger';
import { ApiTags } from '@nestjs/swagger';
import { AVATAR_MIME_TYPES, uuidSchema } from '@wasel/contracts';
import type { Request, Response } from 'express';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../../common/openapi/zod-api.decorators.js';
import { ZodParam } from '../../common/pipes/zod-param.decorators.js';
import { AVATAR_CACHE_CONTROL, avatarEtag, httpDate, isNotModified } from './http-cache.js';
import { ProfileAvatarService } from './profile-avatar.service.js';

/**
 * Serves a colleague's profile picture.
 *
 * Separate from `ProfileController` because it is the one avatar route that
 * names somebody else — the directory and every attendance list draw faces other
 * than the caller's — and it is therefore the only one with a tenancy boundary
 * to enforce. Keeping it apart means the self-service routes stay provably
 * id-free.
 *
 * Authenticated like everything else: the global `JwtAuthGuard` covers it, and
 * there is no `@Public()`. An avatar is personal data, and an unauthenticated
 * `/users/{uuid}/avatar` would be an oracle for which user ids exist.
 */
@ApiTags('profile')
@ApiBearerAuth('access-token')
@Controller('users')
export class UserAvatarController {
  constructor(private readonly avatars: ProfileAvatarService) {}

  /**
   * `@Res()` without `passthrough`: the handler owns the response because the
   * body is bytes, not a serialised object, and because a 304 must carry
   * validators and no body at all — neither of which Nest's return-value path
   * can express.
   *
   * The two-query shape is deliberate. Metadata answers the conditional request
   * without ever loading the image, so a warm client's revalidation costs one
   * narrow indexed read; the bytes are fetched only when a body is actually
   * going out, and the validator sent with them is recomputed **from the row
   * that produced those bytes**. That is what makes a replaced avatar impossible
   * to serve stale: the `ETag` cannot describe a version other than the one on
   * the wire, even if the image was replaced between the two queries.
   */
  @Get(':id/avatar')
  @ApiOperation({
    summary: "A user's profile picture",
    description:
      'Scoped to the caller’s organization: an avatar belonging to another tenant ' +
      'is a 404, indistinguishable from one that does not exist. Revalidates on ' +
      'every use via `ETag`/`Last-Modified`, so a replaced picture is never served ' +
      'stale, and is served with the stored, validated content type under ' +
      '`X-Content-Type-Options: nosniff`.',
  })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiProduces(...AVATAR_MIME_TYPES)
  @ApiResponse({ status: 200, description: 'The image bytes' })
  @ApiResponse({ status: 304, description: 'The client’s copy is current' })
  @ApiErrorResponses(400, 401, 403, 404)
  async avatar(
    @CurrentUser() auth: AuthContext,
    @ZodParam('id', uuidSchema) id: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const metadata = await this.avatars.metadata(auth, id);
    if (!metadata) throw this.avatars.notFound();

    const conditional = {
      ifNoneMatch: request.headers['if-none-match'],
      ifModifiedSince: request.headers['if-modified-since'],
    };

    const validator = avatarEtag(metadata.updatedAt, metadata.byteSize);
    if (isNotModified(conditional, validator, metadata.updatedAt)) {
      this.setValidators(response, metadata.updatedAt, metadata.byteSize);
      response.status(304).end();
      return;
    }

    const content = await this.avatars.content(auth, id);
    // Deleted between the two reads. Not an error worth distinguishing: the
    // caller asked for a picture that is now gone.
    if (!content) throw this.avatars.notFound();

    this.setValidators(response, content.updatedAt, content.byteSize);
    // The *stored* type, which was sniffed from the bytes before they were
    // written — never a type derived from anything the caller sent. `nosniff`
    // then stops a browser second-guessing it, which is what would resurrect the
    // content-sniffing XSS the magic-byte check exists to prevent. Helmet already
    // sets the header globally; it is repeated here because this is the one route
    // whose safety depends on it.
    response.setHeader('Content-Type', content.mimeType);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Length', content.byteSize);
    // An avatar is a picture, never a download, and never a document the browser
    // should navigate to as a top-level page.
    response.setHeader('Content-Disposition', 'inline');
    response.status(200).end(content.data);
  }

  /**
   * `Cache-Control`, `ETag` and `Last-Modified`, on both the 200 and the 304.
   *
   * The `Cache-Control` written here replaces the blanket `no-store` the security
   * middleware sets on every response. That default is right for per-tenant JSON
   * and wrong for a small immutable blob a screen redraws constantly;
   * `private, no-cache` keeps it out of shared caches and forces revalidation
   * before every reuse, which preserves the freshness property while still
   * turning the common case into a bodyless 304.
   */
  private setValidators(response: Response, updatedAt: Date, byteSize: number): void {
    response.setHeader('Cache-Control', AVATAR_CACHE_CONTROL);
    response.setHeader('ETag', avatarEtag(updatedAt, byteSize));
    response.setHeader('Last-Modified', httpDate(updatedAt));
  }
}
