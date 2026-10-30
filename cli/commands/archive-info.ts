import { resolve } from "node:path";
import {
  openArchiveSource,
  verifyArchiveHistory,
  verifyArchiveSnapshot,
  type ArchiveSnapshot,
} from "../../frontend/archive/archive";
import { NodeFileArchiveSource } from "../../frontend/archive/node-source";
import { unlockSnapshotForCli } from "./archive-io";
import { emit } from "./shared";
import type { CliIo, ParsedArguments } from "./shared";

export async function runArchiveInfoCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const source = await NodeFileArchiveSource.open(resolve(path));
  let snapshot: ArchiveSnapshot | undefined;
  try {
    snapshot = await unlockSnapshotForCli(await openArchiveSource(source), action === "verify");
    const history =
      !snapshot.locked && action === "verify" && args.flags.has("history")
        ? await verifyArchiveHistory(snapshot)
        : null;
    const verification =
      history ?? (snapshot.locked ? null : await verifyArchiveSnapshot(snapshot));
    const result = {
      path: resolve(path),
      name: (await snapshot.getManifest()).displayName,
      archiveId: snapshot.header.id,
      generation: snapshot.commit.generation.toString(),
      size: snapshot.source.size.toString(),
      records: verification?.liveRecords ?? 0,
      recordsVerified: verification?.currentRecords ?? 0,
      deletedRecords: verification?.deletedRecords ?? 0,
      encrypted: snapshot.encrypted,
      locked: snapshot.locked,
      verified: verification !== null,
      historicalRevisionsVerified: history?.historicalRevisions ?? null,
      commitsVerified: history?.verifiedCommits ?? null,
      verificationScope: verification
        ? history
          ? "reachable-revisions-and-committed-generations"
          : "all-current-primary-records-and-index"
        : "header-and-index",
    };
    emit(
      output,
      result,
      snapshot.locked
        ? `${result.name}: generation ${result.generation}, encrypted records are locked.`
        : `${result.name}: generation ${result.generation}, ${result.records} live records verified (${result.deletedRecords} in Trash).`,
      args.flags.has("json"),
    );
    return 0;
  } finally {
    snapshot?.lock();
    await source.close();
  }
}
