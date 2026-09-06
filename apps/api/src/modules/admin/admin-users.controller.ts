import { Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  createUserRequestSchema,
  listUsersQuerySchema,
  resetUserPasswordRequestSchema,
  Role,
  updateUserRequestSchema,
  userSchema,
  uuidSchema,
  type CreateUserRequest,
  type ListUsersQuery,
  type Paginated,
  type ResetUserPasswordRequest,
  type UpdateUserRequest,
  type UserDto,
} from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import {
  ApiErrorResponses,
  ApiZodBody,
  ApiZodResponse,
} from '../../common/openapi/zod-api.decorators.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/pipes/zod-param.decorators.js';
import { ClientContext, type ClientInfo } from '../auth/client-context.js';
import { AdminUsersService } from './admin-users.service.js';
import { paginatedUsersSchema } from './admin.schemas.js';

/**
 * Employee administration.
 *
 * `@Roles(Role.ADMIN)` is applied to the **class**, not to each method, and that
 * is deliberate: the roles guard resolves metadata from the handler *or* its
 * controller, so every route here — including one added next year by somebody who
 * never read this file — is admin-only by default. Per-method annotation is one
 * forgotten decorator away from a member-reachable user-management endpoint.
 */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Roles(Role.ADMIN)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @ApiOperation({
    summary: 'List employees',
    description: 'Soft-deleted employees are excluded; their attendance history is not.',
  })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'pageSize', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'search', required: false, description: 'Name, email or employee code' })
  @ApiQuery({ name: 'role', required: false, enum: [Role.ADMIN, Role.MEMBER] })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'SUSPENDED'] })
  @ApiZodResponse(200, paginatedUsersSchema, 'A page of employees')
  @ApiErrorResponses(400, 401, 403)
  list(
    @CurrentUser() auth: AuthContext,
    @ZodQuery(listUsersQuerySchema) query: ListUsersQuery,
  ): Promise<Paginated<UserDto>> {
    return this.users.list(auth, query);
  }

  @Post()
  @ApiOperation({ summary: 'Create an employee' })
  @ApiZodBody(createUserRequestSchema)
  @ApiZodResponse(201, userSchema, 'Created')
  @ApiErrorResponses(400, 401, 403, 409)
  create(
    @CurrentUser() auth: AuthContext,
    @ZodBody(createUserRequestSchema) body: CreateUserRequest,
    @ClientContext() client: ClientInfo,
  ): Promise<UserDto> {
    return this.users.create(auth, body, client);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One employee' })
  @ApiZodResponse(200, userSchema, 'The employee')
  @ApiErrorResponses(400, 401, 403, 404)
  get(@CurrentUser() auth: AuthContext, @ZodParam('id', uuidSchema) id: string): Promise<UserDto> {
    return this.users.get(auth, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an employee',
    description:
      'Rejected with 422 LAST_ADMIN when the change would leave the organization ' +
      'without an active administrator.',
  })
  @ApiZodBody(updateUserRequestSchema)
  @ApiZodResponse(200, userSchema, 'Updated')
  @ApiErrorResponses(400, 401, 403, 404, 409, 422)
  update(
    @CurrentUser() auth: AuthContext,
    @ZodParam('id', uuidSchema) id: string,
    @ZodBody(updateUserRequestSchema) body: UpdateUserRequest,
    @ClientContext() client: ClientInfo,
  ): Promise<UserDto> {
    return this.users.update(auth, id, body, client);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Deactivate an employee',
    description:
      'A soft delete. The row and every attendance record referencing it survive; ' +
      'the employee disappears from the directory and their sessions are revoked.',
  })
  @ApiErrorResponses(400, 401, 403, 404, 422)
  remove(
    @CurrentUser() auth: AuthContext,
    @ZodParam('id', uuidSchema) id: string,
    @ClientContext() client: ClientInfo,
  ): Promise<void> {
    return this.users.remove(auth, id, client);
  }

  @Post(':id/password')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Set an employee password',
    description: 'Revokes every session the employee holds, immediately.',
  })
  @ApiZodBody(resetUserPasswordRequestSchema)
  @ApiErrorResponses(400, 401, 403, 404)
  resetPassword(
    @CurrentUser() auth: AuthContext,
    @ZodParam('id', uuidSchema) id: string,
    @ZodBody(resetUserPasswordRequestSchema) body: ResetUserPasswordRequest,
    @ClientContext() client: ClientInfo,
  ): Promise<void> {
    return this.users.resetPassword(auth, id, body, client);
  }
}
