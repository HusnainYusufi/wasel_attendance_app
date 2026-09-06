-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PunchOutcome" ADD VALUE 'REJECTED_ACCOUNT_SUSPENDED';
ALTER TYPE "PunchOutcome" ADD VALUE 'REJECTED_SHIFT_STILL_OPEN';
ALTER TYPE "PunchOutcome" ADD VALUE 'REJECTED_SHIFT_TOO_SHORT';

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "dayStartsAt" VARCHAR(5) NOT NULL DEFAULT '00:00';
