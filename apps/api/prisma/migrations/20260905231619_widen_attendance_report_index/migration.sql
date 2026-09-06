-- DropIndex
DROP INDEX "attendance_records_organizationId_workDate_idx";

-- CreateIndex
CREATE INDEX "attendance_records_organizationId_workDate_userId_idx" ON "attendance_records"("organizationId", "workDate", "userId");
