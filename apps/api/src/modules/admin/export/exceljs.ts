import excel from 'exceljs';

/**
 * Single ESM interop point for ExcelJS, for the same reason
 * `src/prisma/prisma-client.ts` exists for Prisma.
 *
 * `exceljs` is CommonJS and assembles its exports in a way Node's named-export
 * detector cannot see through, so `import { stream } from 'exceljs'` throws
 * "Named export 'stream' not found" at runtime in this ESM package while
 * typechecking perfectly. The default import always works; the destructure
 * happens here once instead of being rediscovered at runtime by whoever adds the
 * next writer.
 */
export const { WorkbookWriter } = excel.stream.xlsx;
export type StreamingWorkbook = InstanceType<typeof WorkbookWriter>;
