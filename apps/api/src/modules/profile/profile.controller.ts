import { Controller, Delete, Get, HttpCode, Patch, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AVATAR_MAX_BYTES,
  AVATAR_MAX_EDGE_PX,
  AVATAR_MIME_TYPES,
  avatarSummarySchema,
  profileSchema,
  updateProfileRequestSchema,
  type AvatarSummary,
  type ProfileDto,
  type UpdateProfileRequest,
} from '@wasel/contracts';
import type { Request } from 'express';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import {
  ApiErrorResponses,
  ApiZodBody,
  ApiZodResponse,
} from '../../common/openapi/zod-api.decorators.js';
import { ZodBody } from '../../common/pipes/zod-param.decorators.js';
import { ClientContext, type ClientInfo } from '../auth/client-context.js';
import { ProfileAvatarService } from './profile-avatar.service.js';
import { ProfileService } from './profile.service.js';

/**
 * The caller's own account.
 *
 * Every route here is scoped to `auth.userId` and **takes no user id at all**.
 * That is the authorization model, and it is structural rather than enforced by
 * a check: there is no identifier for a member to substitute, so "a member can
 * edit their own profile but not anyone else's" is not a rule this controller
 * applies — it is a shape it cannot express. Editing somebody else remains the
 * admin module's job, behind `@Roles(Role.ADMIN)`.
 *
 * No `@Roles` annotation, deliberately: administrators are users too and have
 * exactly the same right to fix their own name.
 */
@ApiTags('profile')
@ApiBearerAuth('access-token')
@Controller('profile')
export class ProfileController {
  constructor(
    private readonly profile: ProfileService,
    private readonly avatars: ProfileAvatarService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Your own profile',
    description:
      'The same principal `GET /auth/me` returns, plus avatar metadata. The image ' +
      'bytes are fetched separately from `/users/{id}/avatar` so this response ' +
      'stays small enough to cache on the device.',
  })
  @ApiZodResponse(200, profileSchema, 'The current profile')
  @ApiErrorResponses(401, 403)
  get(@CurrentUser() auth: AuthContext): Promise<ProfileDto> {
    return this.profile.get(auth);
  }

  @Patch()
  @ApiOperation({
    summary: 'Update your name or sign-in address',
    description:
      'Changing the email address requires `currentPassword`, and revokes every ' +
      'session including the one making the request — the client must sign in ' +
      'again. Changing only the name does neither. A duplicate address within the ' +
      'organization is refused with 409 `EMAIL_TAKEN` against the `email` field.',
  })
  @ApiZodBody(updateProfileRequestSchema)
  @ApiZodResponse(200, profileSchema, 'The updated profile')
  @ApiErrorResponses(400, 401, 403, 409)
  update(
    @CurrentUser() auth: AuthContext,
    @ZodBody(updateProfileRequestSchema) body: UpdateProfileRequest,
    @ClientContext() client: ClientInfo,
  ): Promise<ProfileDto> {
    return this.profile.update(auth, body, client);
  }

  /**
   * The image arrives as the **raw request body**, not as multipart.
   *
   * A `PUT` whose body is the representation is the plainest reading of REST for
   * "replace this picture", and it is also the only shape available here without
   * new dependencies: `multer` ships as a transitive dependency of
   * `@nestjs/platform-express`, but `@types/multer` does not, so `FileInterceptor`
   * and `Express.Multer.File` do not type-check — and reaching into a package the
   * API does not declare is a phantom dependency that breaks the moment Nest
   * changes its own tree.
   *
   * It is also strictly less machinery for the same job. A multipart envelope
   * around a single unnamed file adds a parser, a temporary-file policy and a
   * field-name convention, and buys nothing: there is one part, its type is the
   * `Content-Type`, and its length is the `Content-Length`.
   *
   * `@Req()` rather than `@Body()` is what keeps the stream intact. Neither
   * registered body parser matches `image/*`, so nothing has consumed the request
   * by the time it reaches here — which is exactly what lets the service cap the
   * read instead of discovering the size after buffering it.
   */
  @Put('avatar')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Upload your profile picture',
    description:
      `The image is the request body; its \`Content-Type\` must be one of ` +
      `${AVATAR_MIME_TYPES.join(', ')} and must agree with the file's own magic ` +
      `bytes. Bodies over ${Math.round(AVATAR_MAX_BYTES / 1024 / 1024)} MB are refused. ` +
      `Clients should re-encode to JPEG at most ${AVATAR_MAX_EDGE_PX}px on the longest ` +
      `edge first, which is what makes "any format the phone can open" work without ` +
      `an image library on the server.`,
  })
  @ApiConsumes(...AVATAR_MIME_TYPES)
  @ApiBody({ required: true, schema: { type: 'string', format: 'binary' } })
  @ApiZodResponse(200, avatarSummarySchema, 'Stored')
  @ApiErrorResponses(400, 401, 403, 413, 415)
  upload(
    @CurrentUser() auth: AuthContext,
    @Req() request: Request,
    @ClientContext() client: ClientInfo,
  ): Promise<AvatarSummary> {
    return this.avatars.replace(
      auth,
      {
        ...(request.headers['content-type'] === undefined
          ? {}
          : { contentType: request.headers['content-type'] }),
        ...(request.headers['content-length'] === undefined
          ? {}
          : { contentLength: request.headers['content-length'] }),
      },
      request,
      client,
    );
  }

  @Delete('avatar')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove your profile picture',
    description: 'Idempotent: removing a picture you do not have is a success.',
  })
  @ApiErrorResponses(401, 403)
  remove(@CurrentUser() auth: AuthContext, @ClientContext() client: ClientInfo): Promise<void> {
    return this.avatars.remove(auth, client);
  }
}
