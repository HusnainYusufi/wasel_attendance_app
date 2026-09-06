export { PrismaService } from './prisma.service.js';
export { PrismaModule } from './prisma.module.js';
export { Prisma, PrismaClient } from './prisma-client.js';
export {
  PrismaErrorCode,
  hasPrismaErrorCode,
  isForeignKeyViolation,
  isKnownPrismaError,
  isNotFound,
  isUniqueViolation,
  uniqueViolationConstraint,
  uniqueViolationFields,
} from './prisma-errors.js';
export type { KnownPrismaError } from './prisma-errors.js';
