-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('PUNCH', 'MANUAL');

-- AlterTable
ALTER TABLE "attendance_records" ADD COLUMN     "enteredAt" TIMESTAMPTZ(3),
ADD COLUMN     "enteredById" UUID,
ADD COLUMN     "note" VARCHAR(255),
ADD COLUMN     "source" "AttendanceSource" NOT NULL DEFAULT 'PUNCH';

-- AlterTable
ALTER TABLE "organizations" ALTER COLUMN "workdayEnd" SET DEFAULT '18:00';

-- CreateTable
CREATE TABLE "user_avatars" (
    "userId" UUID NOT NULL,
    "mimeType" VARCHAR(64) NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_avatars_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "user_avatars" ADD CONSTRAINT "user_avatars_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
