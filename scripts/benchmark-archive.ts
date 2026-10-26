import { performance } from "node:perf_hooks";
import { appendRecords, createArchiveBytes, openArchiveBytes } from "../frontend/archive/archive";
import { RecordType } from "../frontend/archive/format";
import { makeStudentRecord } from "../frontend/domain/records";

const recordCount = Number(process.env["TUTORUX_BENCH_RECORDS"] ?? 10_000);
if (!Number.isSafeInteger(recordCount) || recordCount < 1 || recordCount > 100_000) {
  throw new RangeError("TUTORUX_BENCH_RECORDS must be an integer from 1 to 100,000.");
}

const memoryBefore = process.memoryUsage().rss;
const createStarted = performance.now();
const bytes = await createArchiveBytes("Archive benchmark");
const base = await openArchiveBytes(bytes);
const createMilliseconds = performance.now() - createStarted;

const records = Array.from({ length: recordCount }, (_, index) =>
  makeStudentRecord({
    name: `Benchmark learner ${String(index + 1).padStart(6, "0")}`,
    grade: `Year ${index % 13}`,
    subjects: "Mathematics, Writing",
    objectives: "A repeatable archive benchmark record.",
    tutorNotes: "",
  }),
);

const appendStarted = performance.now();
const populated = await appendRecords(base, records);
const appendMilliseconds = performance.now() - appendStarted;
const listStarted = performance.now();
const listed = await populated.listRecords(RecordType.student);
const listMilliseconds = performance.now() - listStarted;
const memoryAfter = process.memoryUsage().rss;

process.stdout.write(
  `${JSON.stringify(
    {
      runtime: process.version,
      v8: process.versions.v8,
      recordCount,
      archiveBytes: populated.source.size.toString(),
      createAndOpenMilliseconds: Number(createMilliseconds.toFixed(2)),
      appendGenerationMilliseconds: Number(appendMilliseconds.toFixed(2)),
      decodeAndListMilliseconds: Number(listMilliseconds.toFixed(2)),
      recordsListed: listed.length,
      residentMemoryDeltaBytes: memoryAfter - memoryBefore,
      note: "In-memory, unencrypted v1 archive; single append generation.",
    },
    null,
    2,
  )}\n`,
);
