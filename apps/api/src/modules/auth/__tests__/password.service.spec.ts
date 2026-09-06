import { beforeAll, describe, expect, it } from 'vitest';
import { ARGON2_OPTIONS } from '../auth.constants.js';
import { PasswordService } from '../password.service.js';

describe('PasswordService', () => {
  const passwords = new PasswordService();

  beforeAll(async () => {
    await passwords.onModuleInit();
  });

  it('produces an argon2id digest with the configured parameters', async () => {
    const digest = await passwords.hash('CorrectHorse7');

    // The digest encodes its own parameters; asserting on them is what catches a
    // silent weakening of the cost settings in review.
    expect(digest).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(ARGON2_OPTIONS.memoryCost).toBe(19_456);
    expect(ARGON2_OPTIONS.timeCost).toBe(2);
    expect(ARGON2_OPTIONS.parallelism).toBe(1);
  });

  it('never stores the plaintext inside the digest', async () => {
    const digest = await passwords.hash('CorrectHorse7');
    expect(digest).not.toContain('CorrectHorse7');
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [first, second] = await Promise.all([
      passwords.hash('CorrectHorse7'),
      passwords.hash('CorrectHorse7'),
    ]);

    expect(first).not.toBe(second);
    await expect(passwords.verify(first, 'CorrectHorse7')).resolves.toBe(true);
    await expect(passwords.verify(second, 'CorrectHorse7')).resolves.toBe(true);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const digest = await passwords.hash('CorrectHorse7');

    await expect(passwords.verify(digest, 'CorrectHorse7')).resolves.toBe(true);
    await expect(passwords.verify(digest, 'CorrectHorse8')).resolves.toBe(false);
    await expect(passwords.verify(digest, '')).resolves.toBe(false);
  });

  it.each([
    ['empty', ''],
    ['not a digest', 'plaintext'],
    ['truncated', '$argon2id$v=19$m=19456,t=2,p=1$'],
    ['unknown algorithm', '$bcrypt$whatever'],
  ])('returns false rather than throwing on a %s digest', async (_name, digest) => {
    await expect(passwords.verify(digest, 'CorrectHorse7')).resolves.toBe(false);
  });

  it('flags a digest hashed with weaker parameters for rehash', async () => {
    const current = await passwords.hash('CorrectHorse7');
    expect(passwords.needsRehash(current)).toBe(false);

    const weak = '$argon2id$v=19$m=4096,t=1,p=1$c29tZXNhbHRzYWx0$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(passwords.needsRehash(weak)).toBe(true);
  });

  it('spends comparable time on a dummy verification as on a real one', async () => {
    const digest = await passwords.hash('CorrectHorse7');

    const time = async (work: () => Promise<unknown>): Promise<number> => {
      const samples: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const started = performance.now();
        await work();
        samples.push(performance.now() - started);
      }
      samples.sort((a, b) => a - b);
      return samples[2] ?? 0;
    };

    const real = await time(() => passwords.verify(digest, 'WrongPassword1'));
    const dummy = await time(() => passwords.verifyDummy('WrongPassword1'));

    // The dummy path must cost a full argon2 verification. A ratio anywhere near
    // zero would mean the "no such account" branch short-circuits, which is the
    // enumeration oracle this method exists to close.
    expect(dummy / real).toBeGreaterThan(0.5);
    expect(dummy / real).toBeLessThan(2);
  });

  it('has a dummy digest ready without onModuleInit having run', async () => {
    const fresh = new PasswordService();
    await expect(fresh.verifyDummy('anything')).resolves.toBeUndefined();
  });
});
