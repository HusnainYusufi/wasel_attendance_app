import { Reflector } from '@nestjs/core';
import { Role } from '@wasel/contracts';
import { describe, expect, it } from 'vitest';
import { ROLES_KEY } from '../../../common/auth/auth.constants.js';
import { AdminModule } from '../admin.module.js';

type ControllerClass = new (...args: never[]) => object;

/**
 * The controllers as **the module registers them**, not as a list kept by hand.
 *
 * A hand-maintained array plus `expect(handlers).toHaveLength(16)` is a test that
 * cannot fail for the thing it exists to catch: a sixth admin controller added
 * without the annotation is also a controller nobody added to the array, so the
 * suite never looks at it and the count assertion keeps passing on the five it
 * knows about. Reading Nest's own metadata means the test sees exactly what the
 * application mounts, and a new controller is covered the moment it is wired in
 * rather than the moment somebody remembers this file.
 */
const CONTROLLERS: ControllerClass[] =
  (Reflect.getMetadata('controllers', AdminModule) as ControllerClass[] | undefined) ?? [];

/**
 * The module's most important security property, asserted structurally.
 *
 * The integration suite proves that a MEMBER receives 403 from every route that
 * exists *today*; this proves that a route added tomorrow cannot be reachable
 * without the annotation, because the metadata is resolved exactly the way
 * `RolesGuard` resolves it.
 */
describe('admin route authorization metadata', () => {
  const reflector = new Reflector();

  const handlers = CONTROLLERS.flatMap((controller) =>
    Object.getOwnPropertyNames(controller.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => ({
        // A precomputed label, so a controller the module mounts but this file
        // has never heard of still names itself in the failure output.
        label: `${controller.name}.${name}`,
        controller,
        handler: (controller.prototype as unknown as Record<string, unknown>)[name],
      })),
  );

  it('reads the controllers out of the module rather than a hand-kept list', () => {
    // No expected count: the point is that this list cannot drift from the
    // module. It must simply be non-empty, or the per-handler assertions below
    // would vacuously pass.
    expect(CONTROLLERS.length).toBeGreaterThan(0);
    expect(handlers.length).toBeGreaterThan(0);
  });

  it.each(handlers)('$label requires the ADMIN role', ({ controller, handler }) => {
    const roles = reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      handler as () => unknown,
      controller,
    ]);
    expect(roles).toEqual([Role.ADMIN]);
  });
});
