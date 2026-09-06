import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma, Session } from '@prisma/client';
import { ClockService } from '../../common/clock/clock.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { ClientInfo } from './client-context.js';
import { TokenService } from './token.service.js';

export interface IssuedRefreshToken {
  /** The raw token. Returned to the caller once and never stored. */
  token: string;
  sessionId: string;
  familyId: string;
  expiresAt: Date;
}

/** Who a refresh token is minted for. `tokenVersion` travels in the token. */
export interface SessionSubject {
  id: string;
  tokenVersion: number;
}

/** The columns rotation and revocation decisions are made from. */
export type SessionRow = Pick<
  Session,
  'id' | 'userId' | 'familyId' | 'tokenHash' | 'expiresAt' | 'revokedAt' | 'usedAt'
>;

const SESSION_DECISION_SELECT = {
  id: true,
  userId: true,
  familyId: true,
  tokenHash: true,
  expiresAt: true,
  revokedAt: true,
  usedAt: true,
} as const;

/**
 * Refresh-token sessions: issuance, single-use rotation and family revocation.
 *
 * The invariant this class exists to hold: **one row is exchangeable at most
 * once**. Everything about theft detection follows from it, so the consuming
 * update is a conditional `UPDATE` whose affected-row count decides the outcome —
 * never a read followed by a write, which two concurrent refreshes both pass.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly clock: ClockService,
  ) {}

  /** Opens a new rotation family — one per login. */
  async start(subject: SessionSubject, client: ClientInfo): Promise<IssuedRefreshToken> {
    const issued = await this.mint(subject, randomUUID());
    await this.prisma.session.create({ data: this.rowFor(issued, subject.id, client) });
    return issued;
  }

  findByToken(rawToken: string): Promise<SessionRow | null> {
    return this.prisma.session.findUnique({
      where: { tokenHash: this.tokens.hashToken(rawToken) },
      select: SESSION_DECISION_SELECT,
    });
  }

  /**
   * Exchanges `session` for its successor, or returns `null` if it was already
   * spent.
   *
   * The `usedAt: null` predicate is the whole race guard: Postgres serialises the
   * two updates on the row lock, so of any number of concurrent exchanges exactly
   * one sees a match and the rest come back with `count === 0`. The loser is then
   * indistinguishable from a replayed stolen token — which is exactly how the
   * caller must treat it.
   *
   * Consuming and inserting inside one transaction means a crash between them
   * cannot leave a family with no live token.
   */
  async rotate(
    session: SessionRow,
    subject: SessionSubject,
    client: ClientInfo,
  ): Promise<IssuedRefreshToken | null> {
    const issued = await this.mint(subject, session.familyId);
    const now = this.clock.now();

    const won = await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.session.updateMany({
        where: { id: session.id, usedAt: null, revokedAt: null },
        data: { usedAt: now },
      });
      if (consumed.count === 0) return false;

      await tx.session.create({ data: this.rowFor(issued, subject.id, client) });
      return true;
    });

    return won ? issued : null;
  }

  /**
   * Kills every live token in a rotation chain. Rows are marked, not deleted:
   * a revoked session is the evidence that a theft was detected.
   */
  async revokeFamily(familyId: string): Promise<number> {
    const { count } = await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: this.clock.now() },
    });
    return count;
  }

  /** Signs every device out. Paired with a `tokenVersion` bump by the caller. */
  async revokeAllForUser(userId: string): Promise<number> {
    const { count } = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.clock.now() },
    });
    return count;
  }

  private async mint(subject: SessionSubject, familyId: string): Promise<IssuedRefreshToken> {
    const sessionId = randomUUID();
    const { token, expiresAt } = await this.tokens.signRefreshToken({
      userId: subject.id,
      familyId,
      sessionId,
      tokenVersion: subject.tokenVersion,
    });
    return { token, sessionId, familyId, expiresAt };
  }

  private rowFor(
    issued: IssuedRefreshToken,
    userId: string,
    client: ClientInfo,
  ): Prisma.SessionUncheckedCreateInput {
    return {
      id: issued.sessionId,
      userId,
      familyId: issued.familyId,
      tokenHash: this.tokens.hashToken(issued.token),
      expiresAt: issued.expiresAt,
      ipAddress: client.ipAddress,
      userAgent: client.userAgent,
    };
  }
}
