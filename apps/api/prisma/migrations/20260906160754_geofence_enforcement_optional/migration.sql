-- DropForeignKey
ALTER TABLE "attendance_records" DROP CONSTRAINT "attendance_records_checkInSiteId_fkey";

-- AlterTable
ALTER TABLE "attendance_records" ALTER COLUMN "checkInSiteId" DROP NOT NULL,
ALTER COLUMN "checkInDistanceM" DROP NOT NULL;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "enforceGeofence" BOOLEAN NOT NULL DEFAULT true;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_checkInSiteId_fkey" FOREIGN KEY ("checkInSiteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
