import { AVATAR_MAX_BYTES, ErrorCode } from '@wasel/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { ProfileModule } from '../../src/modules/profile/profile.module.js';
import { ProfileAuditAction } from '../../src/modules/profile/profile.constants.js';
import { JPEG_1X1, PNG_1X1, SVG_WITH_SCRIPT, WEBP_1X1, oversizedJpeg } from '../fixtures/images.js';
import {
  createTestApp,
  createUser,
  createUserAndLogin,
  type AuthenticatedActor,
  type HttpRequest,
  type TestApp,
} from '../support/index.js';

/**
 * Superagent parses by content type and has no opinion about `image/*` beyond
 * buffering it; forcing the binary parser is what makes `response.body` the
 * exact bytes the server wrote, which is the only way to prove a round trip.
 */
function binaryParser(res: any, callback: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

const asBinary = (request: HttpRequest): HttpRequest =>
  (request as unknown as { buffer: (v: boolean) => HttpRequest }).buffer(true).parse(binaryParser);

describe('profile avatar', () => {
  let ctx: TestApp;
  let member: AuthenticatedActor;

  beforeAll(async () => {
    ctx = await createTestApp({
      imports: [AuthModule, ProfileModule],
      env: { RATE_LIMIT_MAX: '100000' },
    });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.truncate();
    member = await createUserAndLogin(ctx);
  });

  const upload = (actor: AuthenticatedActor, bytes: Buffer, type: string): HttpRequest =>
    actor.put('/profile/avatar').set('Content-Type', type).send(bytes);

  describe('PUT /profile/avatar', () => {
    it.each([
      ['JPEG', JPEG_1X1, 'image/jpeg'],
      ['PNG', PNG_1X1, 'image/png'],
      ['WebP', WEBP_1X1, 'image/webp'],
    ])('stores a %s and reports its metadata', async (_label, bytes, type) => {
      const response = await upload(member, bytes, type).expect(200);

      expect(response.body).toMatchObject({ mimeType: type, byteSize: bytes.length });
      expect(Date.parse(response.body.updatedAt)).not.toBeNaN();
    });

    it('round-trips the exact bytes, under the stored content type', async () => {
      await upload(member, JPEG_1X1, 'image/jpeg').expect(200);

      const response = await asBinary(member.get(`/users/${member.user.id}/avatar`)).expect(200);

      expect(response.headers['content-type']).toContain('image/jpeg');
      expect(Buffer.compare(response.body, JPEG_1X1)).toBe(0);
    });

    it('appears on the profile once set, and the profile never carries the bytes', async () => {
      await upload(member, JPEG_1X1, 'image/jpeg').expect(200);

      const response = await member.get('/profile').expect(200);
      expect(response.body.avatar).toMatchObject({
        mimeType: 'image/jpeg',
        byteSize: JPEG_1X1.length,
      });
      // The whole reason `UserAvatar` is its own table: this response is fetched
      // on every launch and written to device storage. Asserted as the exact key
      // set rather than a byte budget — a budget passes or fails on how long the
      // tenant happens to be called, which is not what this test is about.
      expect(response.body.avatar).not.toHaveProperty('data');
      expect(Object.keys(response.body.avatar).sort()).toEqual([
        'byteSize',
        'mimeType',
        'updatedAt',
      ]);
    });

    it('replaces rather than accumulating', async () => {
      await upload(member, JPEG_1X1, 'image/jpeg').expect(200);
      await upload(member, PNG_1X1, 'image/png').expect(200);

      const rows = await ctx.prisma.userAvatar.findMany({ where: { userId: member.user.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.mimeType).toBe('image/png');
    });

    it('audits the upload without putting the image in the log', async () => {
      await upload(member, JPEG_1X1, 'image/jpeg').expect(200);

      const entry = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { actorId: member.user.id, action: ProfileAuditAction.AVATAR_UPDATED },
      });
      expect(entry.metadata).toMatchObject({ mimeType: 'image/jpeg', byteSize: JPEG_1X1.length });
    });

    it('touches only the caller — an admin uploading does not alter a member', async () => {
      const admin = await createUserAndLogin(ctx, {
        organizationId: member.organization.id,
        role: 'ADMIN',
      });
      await upload(admin, JPEG_1X1, 'image/jpeg').expect(200);

      // The route keys on the token's subject and takes no id, so there is
      // nothing to point at somebody else.
      const rows = await ctx.prisma.userAvatar.findMany();
      expect(rows.map((row) => row.userId)).toEqual([admin.user.id]);
    });
  });

  describe('what the server refuses, because a Content-Type is a claim', () => {
    it('rejects a PNG that was renamed to .jpg', async () => {
      // The exact "renamed file" case: the header says JPEG, the magic bytes say
      // PNG. Trusting the header would let a caller choose the content type
      // their bytes are later served under.
      const response = await upload(member, PNG_1X1, 'image/jpeg').expect(400);

      expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(response.body.message).toContain('PNG');
      expect(response.body.details).toContainEqual(expect.objectContaining({ path: 'avatar' }));

      const rows = await ctx.prisma.userAvatar.findMany();
      expect(rows).toHaveLength(0);
    });

    it('rejects an SVG declared as an SVG', async () => {
      const response = await upload(member, SVG_WITH_SCRIPT, 'image/svg+xml').expect(415);
      expect(response.body.message).toContain('SVG');
    });

    it('rejects an SVG smuggled under an accepted content type', async () => {
      // The allowlist alone would let this through if the bytes were not
      // sniffed — and an SVG served from this origin executes script in the
      // context of every colleague who opens the directory.
      const response = await upload(member, SVG_WITH_SCRIPT, 'image/png').expect(415);
      expect(response.body.message).toContain('SVG');

      const rows = await ctx.prisma.userAvatar.findMany();
      expect(rows).toHaveLength(0);
    });

    it('rejects an oversized upload with a clear error, not a bare 413', async () => {
      const response = await upload(
        member,
        oversizedJpeg(AVATAR_MAX_BYTES + 1_024),
        'image/jpeg',
      ).expect(413);

      expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(response.body.message).toContain('too large');
      expect(response.body.details).toContainEqual(expect.objectContaining({ path: 'avatar' }));
      expect(response.body.requestId).toEqual(expect.any(String));
    });

    it('accepts an upload right at the cap', async () => {
      // The boundary must not refuse a legitimate image one byte short of the
      // limit; a cap that is off by one is a cap nobody can reason about.
      await upload(member, oversizedJpeg(AVATAR_MAX_BYTES), 'image/jpeg').expect(200);
    });

    it.each([
      ['a missing content type', undefined],
      ['an unsupported image type', 'image/gif'],
      ['a non-image type', 'application/octet-stream'],
      ['HTML', 'text/html'],
    ])('rejects %s with 415', async (_label, type) => {
      const request = member.put('/profile/avatar');
      if (type) request.set('Content-Type', type);
      const response = await request.send(JPEG_1X1).expect(415);
      expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('rejects an empty body', async () => {
      const response = await member
        .put('/profile/avatar')
        .set('Content-Type', 'image/jpeg')
        .send(Buffer.alloc(0))
        .expect(400);
      expect(response.body.message).toContain('empty');
    });

    it('tolerates a content type carrying parameters', async () => {
      await upload(member, JPEG_1X1, 'image/jpeg; charset=binary').expect(200);
    });

    it('requires authentication', async () => {
      await ctx.http
        .put('/api/v1/profile/avatar')
        .set('Content-Type', 'image/jpeg')
        .send(JPEG_1X1)
        .expect(401);
    });
  });

  describe('GET /users/:id/avatar', () => {
    it('serves a colleague inside the same organization', async () => {
      const colleague = await createUserAndLogin(ctx, { organizationId: member.organization.id });
      await upload(colleague, JPEG_1X1, 'image/jpeg').expect(200);

      const response = await asBinary(member.get(`/users/${colleague.user.id}/avatar`)).expect(200);
      expect(Buffer.compare(response.body, JPEG_1X1)).toBe(0);
    });

    it('404s across the tenancy boundary', async () => {
      // The single most important assertion in this file. An avatar is personal
      // data; a cross-tenant read is the IDOR the whole `organizationId` scoping
      // discipline exists to prevent.
      const stranger = await createUserAndLogin(ctx);
      await upload(stranger, JPEG_1X1, 'image/jpeg').expect(200);

      const response = await member.get(`/users/${stranger.user.id}/avatar`).expect(404);
      expect(response.body.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('404s for a soft-deleted employee, exactly as the directory does', async () => {
      const departed = await createUserAndLogin(ctx, { organizationId: member.organization.id });
      await upload(departed, JPEG_1X1, 'image/jpeg').expect(200);
      await ctx.prisma.user.update({
        where: { id: departed.user.id },
        data: { deletedAt: new Date() },
      });

      await member.get(`/users/${departed.user.id}/avatar`).expect(404);
    });

    it('404s for a user with no picture, and for one that does not exist', async () => {
      const colleague = await createUser(ctx, { organizationId: member.organization.id });

      await member.get(`/users/${colleague.user.id}/avatar`).expect(404);
      // Indistinguishable, which is the only answer that is not an oracle for
      // which user ids exist.
      await member.get('/users/3f1a1b2c-1111-4222-8333-444455556666/avatar').expect(404);
    });

    it('400s on a malformed id rather than letting Postgres fail the uuid cast', async () => {
      const response = await member.get('/users/not-a-uuid/avatar').expect(400);
      expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('requires authentication', async () => {
      await upload(member, JPEG_1X1, 'image/jpeg').expect(200);
      await ctx.http.get(`/api/v1/users/${member.user.id}/avatar`).expect(401);
    });

    it('serves the stored type under nosniff, never a caller-chosen one', async () => {
      await upload(member, PNG_1X1, 'image/png').expect(200);

      const response = await asBinary(member.get(`/users/${member.user.id}/avatar`)).expect(200);
      expect(response.headers['content-type']).toContain('image/png');
      // Without this a browser may sniff the bytes and honour its own guess,
      // which is precisely the content-sniffing XSS the magic-byte check exists
      // to close.
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-disposition']).toBe('inline');
    });
  });

  describe('caching — cheap to redraw, impossible to serve stale', () => {
    it('emits validators and a private, revalidate-every-use policy', async () => {
      await upload(member, JPEG_1X1, 'image/jpeg').expect(200);

      const response = await asBinary(member.get(`/users/${member.user.id}/avatar`)).expect(200);
      expect(response.headers['etag']).toMatch(/^"[^"]+"$/);
      expect(response.headers['last-modified']).toEqual(expect.any(String));
      // Overrides the blanket `no-store` the security middleware sets, which is
      // right for per-tenant JSON and wrong for a small immutable blob.
      expect(response.headers['cache-control']).toBe('private, no-cache');
    });

    it('answers 304 to a client that already holds the current version', async () => {
      await upload(member, JPEG_1X1, 'image/jpeg').expect(200);
      const first = await asBinary(member.get(`/users/${member.user.id}/avatar`)).expect(200);

      const revalidated = await member
        .get(`/users/${member.user.id}/avatar`)
        .set('If-None-Match', first.headers['etag'] as string)
        .expect(304);

      expect(revalidated.headers['etag']).toBe(first.headers['etag']);
      expect(revalidated.headers['cache-control']).toBe('private, no-cache');
    });

    it('honours If-Modified-Since when no entity tag is offered', async () => {
      await upload(member, JPEG_1X1, 'image/jpeg').expect(200);
      const first = await asBinary(member.get(`/users/${member.user.id}/avatar`)).expect(200);

      await member
        .get(`/users/${member.user.id}/avatar`)
        .set('If-Modified-Since', first.headers['last-modified'] as string)
        .expect(304);
    });

    it('does not serve a replaced avatar stale', async () => {
      // The failure this guards against is the worst kind of caching bug: the
      // user changes their picture, the app keeps showing the old one, and
      // nothing anywhere reports an error.
      await upload(member, JPEG_1X1, 'image/jpeg').expect(200);
      const before = await asBinary(member.get(`/users/${member.user.id}/avatar`)).expect(200);

      await upload(member, PNG_1X1, 'image/png').expect(200);

      // The stale validator must *not* satisfy the new version.
      const after = await asBinary(
        member
          .get(`/users/${member.user.id}/avatar`)
          .set('If-None-Match', before.headers['etag'] as string),
      ).expect(200);

      expect(after.headers['etag']).not.toBe(before.headers['etag']);
      expect(after.headers['content-type']).toContain('image/png');
      expect(Buffer.compare(after.body, PNG_1X1)).toBe(0);
    });

    it('gives a re-uploaded image a fresh validator even at the same size', async () => {
      await upload(member, JPEG_1X1, 'image/jpeg').expect(200);
      const before = await asBinary(member.get(`/users/${member.user.id}/avatar`)).expect(200);

      await upload(member, JPEG_1X1, 'image/jpeg').expect(200);
      const after = await asBinary(member.get(`/users/${member.user.id}/avatar`)).expect(200);

      expect(after.headers['etag']).not.toBe(before.headers['etag']);
    });
  });

  describe('DELETE /profile/avatar', () => {
    it('removes the picture and empties the profile field', async () => {
      await upload(member, JPEG_1X1, 'image/jpeg').expect(200);

      await member.delete('/profile/avatar').expect(204);

      const profile = await member.get('/profile').expect(200);
      expect(profile.body.avatar).toBeNull();
      await member.get(`/users/${member.user.id}/avatar`).expect(404);
    });

    it('is idempotent — removing a picture you do not have is a success', async () => {
      await member.delete('/profile/avatar').expect(204);
      await member.delete('/profile/avatar').expect(204);
    });

    it('audits a real removal, but does not file a row for a no-op', async () => {
      await member.delete('/profile/avatar').expect(204);
      expect(
        await ctx.prisma.auditLog.count({
          where: { action: ProfileAuditAction.AVATAR_REMOVED },
        }),
      ).toBe(0);

      await upload(member, JPEG_1X1, 'image/jpeg').expect(200);
      await member.delete('/profile/avatar').expect(204);
      expect(
        await ctx.prisma.auditLog.count({
          where: { action: ProfileAuditAction.AVATAR_REMOVED },
        }),
      ).toBe(1);
    });

    it('removes only the caller’s picture', async () => {
      const colleague = await createUserAndLogin(ctx, { organizationId: member.organization.id });
      await upload(member, JPEG_1X1, 'image/jpeg').expect(200);
      await upload(colleague, PNG_1X1, 'image/png').expect(200);

      await member.delete('/profile/avatar').expect(204);

      const rows = await ctx.prisma.userAvatar.findMany();
      expect(rows.map((row) => row.userId)).toEqual([colleague.user.id]);
    });

    it('goes with the account when the row is deleted', async () => {
      // The schema cascades; asserting it here means a future migration that
      // dropped the cascade would leave orphaned image rows and fail loudly.
      await upload(member, JPEG_1X1, 'image/jpeg').expect(200);
      await ctx.prisma.user.delete({ where: { id: member.user.id } });

      expect(await ctx.prisma.userAvatar.count()).toBe(0);
    });
  });
});
