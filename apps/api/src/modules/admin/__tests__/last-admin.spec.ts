import { describe, expect, it } from 'vitest';
import { wouldLeaveNoAdmin } from '../admin-users.service.js';

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CARLA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/**
 * The decision half of the last-admin rule. The race half lives in
 * `AdminUsersService.lockActiveAdmins` and is proved by the concurrent
 * integration test — this file proves the arithmetic in isolation.
 */
describe('wouldLeaveNoAdmin', () => {
  it('blocks removing the only administrator', () => {
    expect(wouldLeaveNoAdmin([ALICE], ALICE, false)).toBe(true);
  });

  it('allows removing one of two administrators', () => {
    expect(wouldLeaveNoAdmin([ALICE, BOB], ALICE, false)).toBe(false);
  });

  it('allows a change that keeps the target an active administrator', () => {
    // Renaming the only admin, or re-saving them unchanged, is not a demotion.
    expect(wouldLeaveNoAdmin([ALICE], ALICE, true)).toBe(false);
  });

  it('allows removing a member even when there is one administrator', () => {
    expect(wouldLeaveNoAdmin([ALICE], CARLA, false)).toBe(false);
  });

  it('allows removing a member of an organization that already has no administrator', () => {
    // Degenerate but reachable through direct database surgery. The rule protects
    // the last admin; it does not conjure one that is not there.
    expect(wouldLeaveNoAdmin([], CARLA, false)).toBe(false);
  });

  it('ignores duplicates in the locked set', () => {
    expect(wouldLeaveNoAdmin([ALICE, ALICE], ALICE, false)).toBe(true);
  });
});
