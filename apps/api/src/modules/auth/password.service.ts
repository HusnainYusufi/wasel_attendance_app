import { randomBytes } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  hash as argon2Hash,
  needsRehash as argon2NeedsRehash,
  verify as argon2Verify,
} from 'argon2';
import { ARGON2_OPTIONS } from './auth.constants.js';

/**
 * Password hashing and verification.
 *
 * Every method takes or returns a digest string and nothing else: no method here
 * ever logs, and no caller is given a reason to put a hash into a context object.
 */
@Injectable()
export class PasswordService implements OnModuleInit {
  /**
   * A digest nobody's password matches, used to spend the same CPU on a login for
   * an address that does not exist as on one that does. Without it, "no such
   * user" returns in microseconds while "wrong password" takes ~50 ms, and that
   * gap is a free account-enumeration oracle regardless of what the body says.
   */
  private dummyDigest: string | null = null;

  /** Computed at boot, so the very first unknown-email login is not the slow one. */
  async onModuleInit(): Promise<void> {
    this.dummyDigest = await this.mintDummyDigest();
  }

  hash(plaintext: string): Promise<string> {
    return argon2Hash(plaintext, ARGON2_OPTIONS);
  }

  /**
   * Constant-time comparison is argon2's own; the `false` on a throw covers a
   * digest that is malformed or was produced by an algorithm this build cannot
   * read. Treating that as "wrong password" rather than letting it escape keeps a
   * corrupted row from turning into a 500 that distinguishes it from a good one.
   */
  async verify(digest: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2Verify(digest, plaintext);
    } catch {
      return false;
    }
  }

  /**
   * Burns one verification against the dummy digest. Called on the "no such
   * account" path so that its timing is indistinguishable from a wrong password.
   */
  async verifyDummy(plaintext: string): Promise<void> {
    this.dummyDigest ??= await this.mintDummyDigest();
    await this.verify(this.dummyDigest, plaintext);
  }

  /** True when a stored digest was produced with weaker parameters than current. */
  needsRehash(digest: string): boolean {
    const { timeCost, memoryCost, parallelism } = ARGON2_OPTIONS;
    return argon2NeedsRehash(digest, { timeCost, memoryCost, parallelism });
  }

  private mintDummyDigest(): Promise<string> {
    // A random password, not a constant: the digest is never compared against a
    // real one, and a fixed value in the source would invite somebody to "reuse"
    // it as a placeholder password for a seeded account.
    return this.hash(randomBytes(32).toString('base64'));
  }
}
