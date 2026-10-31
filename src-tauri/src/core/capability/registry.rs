use super::types::{Capability, Family, Port};

const T_HELP: &str = "tests/cli/main.test.ts::CLI encrypted archive access::unlocks, verifies, reads, and appends an encrypted archive generation";
const T_ARCHIVE_INIT: &str = "tests/frontend/cli.test.ts::TypeScript CLI::creates, updates, lists, and verifies a portable archive";
const T_ARCHIVE_INFO: &str = "tests/frontend/cli.test.ts::TypeScript CLI::creates, updates, lists, and verifies a portable archive";
const T_ARCHIVE_VERIFY: &str = "tests/cli/main.test.ts::CLI encrypted archive access::unlocks, verifies, reads, and appends an encrypted archive generation";
const T_ARCHIVE_ENCRYPT: &str = "tests/cli/main.test.ts::CLI encrypted archive access::creates encrypted archives from a passphrase environment variable";
const T_ARCHIVE_SANITIZE: &str = "tests/cli/main.test.ts::CLI sanitized archive copies::requires a reviewed sanitized-copy preview and publishes a private-data-filtered archive";
const T_ARCHIVE_RECOVERY: &str = "tests/frontend/cli.test.ts::TypeScript CLI::previews and applies recovery for a complete unpublished generation";
const T_ARCHIVE_COMPACT: &str = "tests/frontend/cli.test.ts::TypeScript CLI::previews archive compaction with --preview and applies by default";
const T_ARCHIVE_REPAIR: &str = "tests/frontend/cli.test.ts::TypeScript CLI::creates a verified repair copy without changing the damaged source";
const T_ARCHIVE_BACKUP: &str = "tests/rust-parity/corpus.json#archive.backup.confirm-required";
const T_ARCHIVE_DISCOVER: &str = "tests/frontend/archive/archive.test.ts::archive reader";
const T_STUDENT: &str = "tests/frontend/cli.test.ts::TypeScript CLI::shows student history and reviews source-backed progress";
const T_STUDENT_LIFECYCLE: &str = "tests/frontend/domain/records.test.ts::student profile lifecycle";
const T_SESSION: &str = "tests/frontend/cli.test.ts::TypeScript CLI::shows student history and reviews source-backed progress";
const T_SESSION_PACKAGE: &str = "tests/cli/main.test.ts::CLI session package transfer::exports a private package, preserves no-overwrite behavior, and imports to a fresh session";
const T_SESSION_TRASH: &str = "tests/frontend/domain/session-trash.test.ts::session group restore";
const T_JOURNAL: &str = "tests/cli/cli-parity.test.ts::CLI legacy parity::uses flat record JSON, default journal fields, and document block preservation";
const T_JOURNAL_TRASH: &str = "tests/cli/cli-parity.test.ts::CLI legacy parity::trashes and restores the journal entry and its notes as one group";
const T_JOURNAL_ORGANIZER: &str = "tests/frontend/cli.test.ts::TypeScript CLI::organizes journal entries with collections and tags from the CLI";
const T_ANNOTATION: &str = "tests/frontend/cli.test.ts::TypeScript CLI::creates, edits, duplicates, lists, and removes session annotations";
const T_ANNOTATION_SPLIT: &str = "tests/frontend/cli.test.ts::TypeScript CLI::splits and merges annotation ranges without losing their source records";
const T_ANNOTATION_LINK: &str = "tests/frontend/cli.test.ts::TypeScript CLI::links annotations to session materials and evidence records";
const T_ASSET: &str = "tests/cli/cli-parity.test.ts::CLI legacy parity::overwrites an existing asset export destination atomically";
const T_EVIDENCE: &str = "tests/frontend/domain/evidence.test.ts::evidence editing and recoverable relationships";
const T_EVIDENCE_GRAPH: &str = "tests/frontend/domain/evidence-graph.test.ts::evidence graph layout";
const T_GUIDE: &str = "tests/frontend/domain/guides.test.ts::guide parity behavior";
const T_GUIDE_EXPORT: &str = "tests/frontend/domain/guide-export.test.ts::study guide exports";
const T_TEMPLATE: &str = "tests/cli/commands/templates.test.ts::template CLI parity::imports plain guidance and applies built-in overrides";
const T_SETTINGS: &str = "tests/frontend/archive/archive.test.ts::archive reader";
const T_AI: &str = "tests/cli/commands/ai-parity.test.ts::AI CLI parity::returns the legacy provider schema with the catalog as an additive field";
const T_AI_GENERATE: &str = "tests/cli/commands/ai-parity.test.ts::AI CLI parity::inspects an embedded GGUF locally and never routes ai test to HTTP discovery";
const T_MODEL: &str = "tests/cli/commands/ai-parity.test.ts::AI CLI parity::inspects an embedded GGUF locally and never routes ai test to HTTP discovery";
const T_DIAGNOSTICS: &str = "tests/cli/diagnostics.test.ts::CLI audio diagnostics::reports inspected native endpoint configuration";
const T_BENCHMARK: &str = "tests/cli/cli-parity.test.ts::CLI legacy parity::reports benchmark index scalars and audio export metadata as legacy strings";
const T_RECORD: &str = "tests/cli/main.test.ts::CLI recording take management::lists, renames, trashes, and restores takes with their audio intact";
const T_AUDIO: &str = "tests/frontend/domain/audio.test.ts::archive audio playback";
const T_TRANSCRIPT: &str = "tests/frontend/cli.test.ts::TypeScript CLI::imports, reviews, searches, and exports session transcript cues";
const T_TRANSCRIPT_RECORDS: &str = "tests/frontend/domain/transcript.test.ts::transcript archive records and export";
const T_WHISPER: &str = "tests/frontend/domain/whisper.test.ts::Whisper transcript records";

macro_rules! cap {
    ($id:literal, $family:ident, [$($cli:literal),+], [$($alias:literal),*], $desktop:literal, [$($port:ident),+], $test:expr) => {
        Capability {
            id: $id,
            family: Family::$family,
            cli: &[$($cli),+],
            cli_aliases: &[$($alias),*],
            desktop: $desktop,
            ports: &[$(Port::$port),+],
            integration_test: $test,
        }
    };
}

pub const CAPABILITIES: &[Capability] = &[
    // Global
    cap!("cli.help", Cli, ["help"], ["--help", "-h"], "console:help", [Output], T_HELP),
    cap!("cli.version", Cli, ["version"], ["--version", "-v"], "console:version", [Output], T_HELP),
    // Archive
    cap!("archive.discover", Archive, ["archive", "discover"], ["archive list"], "console:archive discover", [Filesystem, Archive, Output], T_ARCHIVE_DISCOVER),
    cap!("archive.init", Archive, ["archive", "init"], [], "console:archive init", [Filesystem, Clock, Uuid, Crypto, Archive, Output], T_ARCHIVE_INIT),
    cap!("archive.rename", Archive, ["archive", "rename"], [], "console:archive rename", [Filesystem, Archive, Output, SecretStore, Environment], T_ARCHIVE_INFO),
    cap!("archive.encrypt", Archive, ["archive", "encrypt"], [], "console:archive encrypt", [Filesystem, Crypto, Archive, Output, SecretStore, Environment], T_ARCHIVE_ENCRYPT),
    cap!("archive.unlock", Archive, ["archive", "unlock"], [], "console:archive unlock", [Filesystem, Crypto, Archive, Output, SecretStore, Environment], T_ARCHIVE_VERIFY),
    cap!("archive.change-passphrase", Archive, ["archive", "change-passphrase"], [], "console:archive change-passphrase", [Filesystem, Crypto, Archive, Output, SecretStore, Environment], T_ARCHIVE_ENCRYPT),
    cap!("archive.info", Archive, ["archive", "info"], [], "console:archive info", [Filesystem, Archive, Output], T_ARCHIVE_INFO),
    cap!("archive.open", Archive, ["archive", "open"], [], "console:archive open", [Filesystem, Archive, Output], T_ARCHIVE_INFO),
    cap!("archive.verify", Archive, ["archive", "verify"], [], "console:archive verify", [Filesystem, Archive, Output], T_ARCHIVE_VERIFY),
    cap!("archive.backup", Archive, ["archive", "backup"], ["archive copy"], "console:archive backup", [Filesystem, Archive, Output], T_ARCHIVE_BACKUP),
    cap!("archive.recover", Archive, ["archive", "recover"], [], "console:archive recover", [Filesystem, Archive, Output], T_ARCHIVE_RECOVERY),
    cap!("archive.compact", Archive, ["archive", "compact"], [], "console:archive compact", [Filesystem, Archive, Output], T_ARCHIVE_COMPACT),
    cap!("archive.backfill-indexes", Archive, ["archive", "backfill-indexes"], [], "console:archive backfill-indexes", [Filesystem, Archive, Output], T_ARCHIVE_VERIFY),
    cap!("archive.repair", Archive, ["archive", "repair"], [], "console:archive repair", [Filesystem, Archive, Output], T_ARCHIVE_REPAIR),
    cap!("archive.rebuild-index", Archive, ["archive", "rebuild-index"], [], "console:archive rebuild-index", [Filesystem, Archive, Output], T_ARCHIVE_REPAIR),
    cap!("archive.sanitize", Archive, ["archive", "sanitize"], [], "console:archive sanitize", [Filesystem, Crypto, Archive, Output, SecretStore, Environment], T_ARCHIVE_SANITIZE),
    // Students
    cap!("student.create", Student, ["student", "create"], [], "console:student create", [Filesystem, Clock, Uuid, Archive, Output], T_STUDENT),
    cap!("student.list", Student, ["student", "list"], [], "console:student list", [Filesystem, Archive, Output], T_STUDENT_LIFECYCLE),
    cap!("student.show", Student, ["student", "show"], [], "console:student show", [Filesystem, Archive, Output], T_STUDENT_LIFECYCLE),
    cap!("student.update", Student, ["student", "update"], [], "console:student update", [Filesystem, Clock, Archive, Output], T_STUDENT_LIFECYCLE),
    cap!("student.delete", Student, ["student", "delete"], [], "console:student delete", [Filesystem, Clock, Archive, Output], T_STUDENT_LIFECYCLE),
    cap!("student.restore", Student, ["student", "restore"], [], "console:student restore", [Filesystem, Clock, Archive, Output], T_STUDENT_LIFECYCLE),
    cap!("student.history", Student, ["student", "history"], [], "console:student history", [Filesystem, Archive, Output], T_STUDENT),
    cap!("student.progress", Student, ["student", "progress"], [], "console:student progress", [Filesystem, Archive, Output], T_STUDENT),
    cap!("student.progress-review", Student, ["student", "progress-review"], [], "console:student progress-review", [Filesystem, Clock, Uuid, Archive, Output], T_STUDENT),
    // Sessions
    cap!("session.create", Session, ["session", "create"], [], "console:session create", [Filesystem, Clock, Uuid, Archive, Output], T_SESSION),
    cap!("session.list", Session, ["session", "list"], [], "console:session list", [Filesystem, Archive, Output], T_SESSION),
    cap!("session.show", Session, ["session", "show"], [], "console:session show", [Filesystem, Archive, Output], T_SESSION),
    cap!("session.verify", Session, ["session", "verify"], [], "console:session verify", [Filesystem, Archive, Output], T_SESSION),
    cap!("session.update", Session, ["session", "update"], [], "console:session update", [Filesystem, Clock, Archive, Output], T_SESSION),
    cap!("session.clone", Session, ["session", "clone"], [], "console:session clone", [Filesystem, Clock, Uuid, Archive, Output], T_SESSION),
    cap!("session.export", Session, ["session", "export"], [], "console:session export", [Filesystem, Archive, Output], T_SESSION_PACKAGE),
    cap!("session.import", Session, ["session", "import"], [], "console:session import", [Filesystem, Archive, Output], T_SESSION_PACKAGE),
    cap!("session.archive", Session, ["session", "archive"], [], "console:session archive", [Filesystem, Clock, Archive, Output], T_SESSION_TRASH),
    cap!("session.unarchive", Session, ["session", "unarchive"], [], "console:session unarchive", [Filesystem, Clock, Archive, Output], T_SESSION_TRASH),
    cap!("session.start", Session, ["session", "start"], [], "console:session start", [Filesystem, Clock, Archive, Output], T_SESSION),
    cap!("session.complete", Session, ["session", "complete"], [], "console:session complete", [Filesystem, Clock, Archive, Output], T_SESSION),
    cap!("session.review", Session, ["session", "review"], [], "console:session review", [Filesystem, Clock, Archive, Output], T_SESSION),
    cap!("session.resume", Session, ["session", "resume"], [], "console:session resume", [Filesystem, Clock, Archive, Output], T_SESSION),
    cap!("session.recover", Session, ["session", "recover"], [], "console:session recover", [Filesystem, Clock, AudioCapture, Archive, Output], T_RECORD),
    cap!("session.delete", Session, ["session", "delete"], [], "console:session delete", [Filesystem, Clock, Archive, Output], T_SESSION_TRASH),
    cap!("session.restore", Session, ["session", "restore"], [], "console:session restore", [Filesystem, Clock, Archive, Output], T_SESSION_TRASH),
    // Journal entries and aliases
    cap!("journal.create", Journal, ["journal", "create"], ["journal entry create"], "console:journal create", [Filesystem, Clock, Uuid, Archive, Output], T_JOURNAL),
    cap!("journal.update", Journal, ["journal", "update"], ["journal entry update"], "console:journal update", [Filesystem, Clock, Archive, Output], T_JOURNAL),
    cap!("journal.list", Journal, ["journal", "list"], ["journal entry list"], "console:journal list", [Filesystem, Archive, Output], T_JOURNAL),
    cap!("journal.search", Journal, ["journal", "search"], ["journal entry search"], "console:journal search", [Filesystem, Archive, Output], T_JOURNAL),
    cap!("journal.show", Journal, ["journal", "show"], ["journal entry show"], "console:journal show", [Filesystem, Archive, Output], T_JOURNAL),
    cap!("journal.delete", Journal, ["journal", "delete"], ["journal entry delete"], "console:journal delete", [Filesystem, Clock, Archive, Output], T_JOURNAL_TRASH),
    cap!("journal.restore", Journal, ["journal", "restore"], ["journal entry restore"], "console:journal restore", [Filesystem, Clock, Archive, Output], T_JOURNAL_TRASH),
    // Journal documents
    cap!("journal.document.show", Journal, ["journal", "document", "show"], [], "console:journal document show", [Filesystem, Archive, Output], T_JOURNAL),
    cap!("journal.document.update", Journal, ["journal", "document", "update"], [], "console:journal document update", [Filesystem, Clock, Archive, Output], T_JOURNAL),
    cap!("journal.document.add-block", Journal, ["journal", "document", "add-block"], [], "console:journal document add-block", [Filesystem, Clock, Uuid, Archive, Output], T_JOURNAL),
    cap!("journal.document.remove-block", Journal, ["journal", "document", "remove-block"], [], "console:journal document remove-block", [Filesystem, Clock, Archive, Output], T_JOURNAL),
    cap!("journal.document.restore-block", Journal, ["journal", "document", "restore-block"], [], "console:journal document restore-block", [Filesystem, Clock, Archive, Output], T_JOURNAL),
    cap!("journal.document.move-block", Journal, ["journal", "document", "move-block"], [], "console:journal document move-block", [Filesystem, Clock, Archive, Output], T_JOURNAL),
    // Journal collections
    cap!("journal.collection.list", Journal, ["journal", "collection", "list"], [], "console:journal collection list", [Filesystem, Archive, Output], T_JOURNAL_ORGANIZER),
    cap!("journal.collection.create", Journal, ["journal", "collection", "create"], [], "console:journal collection create", [Filesystem, Clock, Uuid, Archive, Output], T_JOURNAL_ORGANIZER),
    cap!("journal.collection.show", Journal, ["journal", "collection", "show"], [], "console:journal collection show", [Filesystem, Archive, Output], T_JOURNAL_ORGANIZER),
    cap!("journal.collection.update", Journal, ["journal", "collection", "update"], [], "console:journal collection update", [Filesystem, Clock, Archive, Output], T_JOURNAL_ORGANIZER),
    cap!("journal.collection.delete", Journal, ["journal", "collection", "delete"], [], "console:journal collection delete", [Filesystem, Clock, Archive, Output], T_JOURNAL_ORGANIZER),
    cap!("journal.collection.restore", Journal, ["journal", "collection", "restore"], [], "console:journal collection restore", [Filesystem, Clock, Archive, Output], T_JOURNAL_ORGANIZER),
    // Journal tags
    cap!("journal.tag.list", Journal, ["journal", "tag", "list"], [], "console:journal tag list", [Filesystem, Archive, Output], T_JOURNAL_ORGANIZER),
    cap!("journal.tag.create", Journal, ["journal", "tag", "create"], [], "console:journal tag create", [Filesystem, Clock, Uuid, Archive, Output], T_JOURNAL_ORGANIZER),
    cap!("journal.tag.show", Journal, ["journal", "tag", "show"], [], "console:journal tag show", [Filesystem, Archive, Output], T_JOURNAL_ORGANIZER),
    cap!("journal.tag.update", Journal, ["journal", "tag", "update"], [], "console:journal tag update", [Filesystem, Clock, Archive, Output], T_JOURNAL_ORGANIZER),
    cap!("journal.tag.delete", Journal, ["journal", "tag", "delete"], [], "console:journal tag delete", [Filesystem, Clock, Archive, Output], T_JOURNAL_ORGANIZER),
    cap!("journal.tag.restore", Journal, ["journal", "tag", "restore"], [], "console:journal tag restore", [Filesystem, Clock, Archive, Output], T_JOURNAL_ORGANIZER),
    // Annotations
    cap!("annotation.add", Annotation, ["annotation", "add"], [], "console:annotation add", [Filesystem, Clock, Uuid, Archive, Output], T_ANNOTATION),
    cap!("annotation.list", Annotation, ["annotation", "list"], [], "console:annotation list", [Filesystem, Archive, Output], T_ANNOTATION),
    cap!("annotation.update", Annotation, ["annotation", "update"], [], "console:annotation update", [Filesystem, Clock, Archive, Output], T_ANNOTATION),
    cap!("annotation.remove", Annotation, ["annotation", "remove"], [], "console:annotation remove", [Filesystem, Clock, Archive, Output], T_ANNOTATION),
    cap!("annotation.prioritize", Annotation, ["annotation", "prioritize"], [], "console:annotation prioritize", [Filesystem, Clock, Archive, Output], T_ANNOTATION),
    cap!("annotation.duplicate", Annotation, ["annotation", "duplicate"], [], "console:annotation duplicate", [Filesystem, Clock, Uuid, Archive, Output], T_ANNOTATION),
    cap!("annotation.history", Annotation, ["annotation", "history"], [], "console:annotation history", [Filesystem, Archive, Output], T_ANNOTATION),
    cap!("annotation.restore", Annotation, ["annotation", "restore"], [], "console:annotation restore", [Filesystem, Clock, Archive, Output], T_ANNOTATION),
    cap!("annotation.merge", Annotation, ["annotation", "merge"], [], "console:annotation merge", [Filesystem, Clock, Archive, Output], T_ANNOTATION_SPLIT),
    cap!("annotation.split", Annotation, ["annotation", "split"], [], "console:annotation split", [Filesystem, Clock, Uuid, Archive, Output], T_ANNOTATION_SPLIT),
    cap!("annotation.link", Annotation, ["annotation", "link"], [], "console:annotation link", [Filesystem, Clock, Archive, Output], T_ANNOTATION_LINK),
    cap!("annotation.unlink", Annotation, ["annotation", "unlink"], [], "console:annotation unlink", [Filesystem, Clock, Archive, Output], T_ANNOTATION_LINK),
    cap!("annotation.show", Annotation, ["annotation", "show"], [], "console:annotation show", [Filesystem, Archive, Output], T_ANNOTATION),
    cap!("annotation.plan", Annotation, ["annotation", "plan"], [], "console:annotation plan", [Filesystem, Archive, Output], T_ANNOTATION),
    // Assets
    cap!("asset.add", Asset, ["asset", "add"], ["asset import"], "console:asset add", [Filesystem, Clock, Uuid, Crypto, Archive, Output], T_ASSET),
    cap!("asset.import-folder", Asset, ["asset", "import-folder"], [], "console:asset import-folder", [Filesystem, Clock, Uuid, Crypto, Archive, Output], T_ASSET),
    cap!("asset.list", Asset, ["asset", "list"], [], "console:asset list", [Filesystem, Archive, Output], T_ASSET),
    cap!("asset.show", Asset, ["asset", "show"], [], "console:asset show", [Filesystem, Archive, Output], T_ASSET),
    cap!("asset.preview", Asset, ["asset", "preview"], [], "console:asset preview", [Filesystem, Archive, Output], T_ASSET),
    cap!("asset.verify", Asset, ["asset", "verify"], [], "console:asset verify", [Filesystem, Archive, Output], T_ASSET),
    cap!("asset.remove", Asset, ["asset", "remove"], [], "console:asset remove", [Filesystem, Clock, Archive, Output], T_ASSET),
    cap!("asset.restore", Asset, ["asset", "restore"], [], "console:asset restore", [Filesystem, Clock, Archive, Output], T_ASSET),
    cap!("asset.update", Asset, ["asset", "update"], [], "console:asset update", [Filesystem, Clock, Archive, Output], T_ASSET),
    cap!("asset.history", Asset, ["asset", "history"], [], "console:asset history", [Filesystem, Archive, Output], T_ASSET),
    cap!("asset.extract", Asset, ["asset", "extract"], ["asset export"], "console:asset extract", [Filesystem, Archive, Output], T_ASSET),
    cap!("asset.link", Asset, ["asset", "link"], [], "console:asset link", [Filesystem, Clock, Archive, Output], T_ASSET),
    cap!("asset.unlink", Asset, ["asset", "unlink"], [], "console:asset unlink", [Filesystem, Clock, Archive, Output], T_ASSET),
    // Evidence
    cap!("evidence.extract", Evidence, ["evidence", "extract"], [], "console:evidence extract", [Filesystem, Clock, Uuid, Archive, Output], T_EVIDENCE),
    cap!("evidence.list", Evidence, ["evidence", "list"], [], "console:evidence list", [Filesystem, Archive, Output], T_EVIDENCE),
    cap!("evidence.review", Evidence, ["evidence", "review"], [], "console:evidence review", [Filesystem, Archive, Output], T_EVIDENCE),
    cap!("evidence.create", Evidence, ["evidence", "create"], [], "console:evidence create", [Filesystem, Clock, Uuid, Archive, Output], T_EVIDENCE),
    cap!("evidence.approve", Evidence, ["evidence", "approve"], [], "console:evidence approve", [Filesystem, Clock, Archive, Output], T_EVIDENCE),
    cap!("evidence.reject", Evidence, ["evidence", "reject"], [], "console:evidence reject", [Filesystem, Clock, Archive, Output], T_EVIDENCE),
    cap!("evidence.verify", Evidence, ["evidence", "verify"], [], "console:evidence verify", [Filesystem, Clock, Archive, Output], T_EVIDENCE),
    cap!("evidence.show", Evidence, ["evidence", "show"], [], "console:evidence show", [Filesystem, Archive, Output], T_EVIDENCE),
    cap!("evidence.update", Evidence, ["evidence", "update"], [], "console:evidence update", [Filesystem, Clock, Archive, Output], T_EVIDENCE),
    cap!("evidence.delete", Evidence, ["evidence", "delete"], [], "console:evidence delete", [Filesystem, Clock, Archive, Output], T_EVIDENCE),
    cap!("evidence.restore", Evidence, ["evidence", "restore"], [], "console:evidence restore", [Filesystem, Clock, Archive, Output], T_EVIDENCE),
    cap!("evidence.link", Evidence, ["evidence", "link"], [], "console:evidence link", [Filesystem, Clock, Uuid, Archive, Output], T_EVIDENCE_GRAPH),
    cap!("evidence.unlink", Evidence, ["evidence", "unlink"], [], "console:evidence unlink", [Filesystem, Clock, Archive, Output], T_EVIDENCE_GRAPH),
    cap!("evidence.edges", Evidence, ["evidence", "edges"], [], "console:evidence edges", [Filesystem, Archive, Output], T_EVIDENCE_GRAPH),
    cap!("evidence.graph", Evidence, ["evidence", "graph"], [], "console:evidence graph", [Filesystem, Archive, Output], T_EVIDENCE_GRAPH),
    // Guides
    cap!("guide.create", Guide, ["guide", "create"], [], "console:guide create", [Filesystem, Clock, Uuid, Archive, Output], T_GUIDE),
    cap!("guide.generate", Guide, ["guide", "generate"], [], "console:guide generate", [Filesystem, Clock, Uuid, Archive, AiBackend, Output], T_GUIDE),
    cap!("guide.regenerate", Guide, ["guide", "regenerate"], [], "console:guide regenerate", [Filesystem, Clock, Uuid, Archive, AiBackend, Output], T_GUIDE),
    cap!("guide.list", Guide, ["guide", "list"], [], "console:guide list", [Filesystem, Archive, Output], T_GUIDE),
    cap!("guide.show", Guide, ["guide", "show"], [], "console:guide show", [Filesystem, Archive, Output], T_GUIDE),
    cap!("guide.approve", Guide, ["guide", "approve"], [], "console:guide approve", [Filesystem, Clock, Archive, Output], T_GUIDE),
    cap!("guide.trash", Guide, ["guide", "trash"], [], "console:guide trash", [Filesystem, Clock, Archive, Output], T_GUIDE),
    cap!("guide.restore", Guide, ["guide", "restore"], [], "console:guide restore", [Filesystem, Clock, Archive, Output], T_GUIDE),
    cap!("guide.history", Guide, ["guide", "history"], [], "console:guide history", [Filesystem, Archive, Output], T_GUIDE),
    cap!("guide.compare", Guide, ["guide", "compare"], [], "console:guide compare", [Filesystem, Archive, Output], T_GUIDE),
    cap!("guide.validate", Guide, ["guide", "validate"], [], "console:guide validate", [Filesystem, Archive, Output], T_GUIDE),
    cap!("guide.update", Guide, ["guide", "update"], [], "console:guide update", [Filesystem, Clock, Archive, Output], T_GUIDE),
    cap!("guide.add-section", Guide, ["guide", "add-section"], ["guide section"], "console:guide add-section", [Filesystem, Clock, Uuid, Archive, Output], T_GUIDE),
    cap!("guide.edit", Guide, ["guide", "edit"], [], "console:guide edit", [Filesystem, Clock, Archive, Output], T_GUIDE),
    cap!("guide.move-section", Guide, ["guide", "move-section"], [], "console:guide move-section", [Filesystem, Clock, Archive, Output], T_GUIDE),
    cap!("guide.move-block", Guide, ["guide", "move-block"], [], "console:guide move-block", [Filesystem, Clock, Archive, Output], T_GUIDE),
    cap!("guide.remove-section", Guide, ["guide", "remove-section"], [], "console:guide remove-section", [Filesystem, Clock, Archive, Output], T_GUIDE),
    cap!("guide.add-block", Guide, ["guide", "add-block"], [], "console:guide add-block", [Filesystem, Clock, Uuid, Archive, Output], T_GUIDE),
    cap!("guide.update-block", Guide, ["guide", "update-block"], [], "console:guide update-block", [Filesystem, Clock, Archive, Output], T_GUIDE),
    cap!("guide.remove-block", Guide, ["guide", "remove-block"], [], "console:guide remove-block", [Filesystem, Clock, Archive, Output], T_GUIDE),
    cap!("guide.duplicate", Guide, ["guide", "duplicate"], [], "console:guide duplicate", [Filesystem, Clock, Uuid, Archive, Output], T_GUIDE),
    cap!("guide.export", Guide, ["guide", "export"], [], "console:guide export", [Filesystem, Archive, Output], T_GUIDE_EXPORT),
    // Templates
    cap!("template.list", Template, ["template", "list"], [], "console:template list", [Filesystem, Archive, Output], T_TEMPLATE),
    cap!("template.show", Template, ["template", "show"], [], "console:template show", [Filesystem, Archive, Output], T_TEMPLATE),
    cap!("template.create", Template, ["template", "create"], [], "console:template create", [Filesystem, Clock, Uuid, Archive, Output], T_TEMPLATE),
    cap!("template.update", Template, ["template", "update"], [], "console:template update", [Filesystem, Clock, Archive, Output], T_TEMPLATE),
    cap!("template.delete", Template, ["template", "delete"], [], "console:template delete", [Filesystem, Clock, Archive, Output], T_TEMPLATE),
    cap!("template.restore", Template, ["template", "restore"], [], "console:template restore", [Filesystem, Clock, Archive, Output], T_TEMPLATE),
    cap!("template.import", Template, ["template", "import"], [], "console:template import", [Filesystem, Clock, Uuid, Archive, Output], T_TEMPLATE),
    cap!("template.export", Template, ["template", "export"], [], "console:template export", [Filesystem, Archive, Output], T_TEMPLATE),
    // Settings
    cap!("settings.list", Settings, ["settings", "list"], [], "console:settings list", [Filesystem, Archive, Output], T_SETTINGS),
    cap!("settings.get", Settings, ["settings", "get"], [], "console:settings get", [Filesystem, Archive, Output], T_SETTINGS),
    cap!("settings.set", Settings, ["settings", "set"], [], "console:settings set", [Filesystem, Archive, Output, SecretStore, Environment], T_SETTINGS),
    cap!("settings.reset", Settings, ["settings", "reset"], [], "console:settings reset", [Filesystem, Archive, Output], T_SETTINGS),
    cap!("settings.import", Settings, ["settings", "import"], [], "console:settings import", [Filesystem, Archive, Output, SecretStore, Environment], T_SETTINGS),
    cap!("settings.copy-to-archive", Settings, ["settings", "copy-to-archive"], [], "console:settings copy-to-archive", [Filesystem, Archive, Output], T_SETTINGS),
    cap!("settings.credential-list", Settings, ["settings", "credential-list"], [], "console:settings credential-list", [Filesystem, Archive, Output, SecretStore], T_SETTINGS),
    cap!("settings.credential-remove", Settings, ["settings", "credential-remove"], [], "console:settings credential-remove", [Filesystem, Archive, Output, SecretStore], T_SETTINGS),
    // AI
    cap!("ai.providers", Ai, ["ai", "providers"], [], "console:ai providers", [Filesystem, Archive, Network, Output], T_AI),
    cap!("ai.context", Ai, ["ai", "context"], [], "console:ai context", [Filesystem, Archive, Output], T_AI),
    cap!("ai.models", Ai, ["ai", "models"], [], "console:ai models", [Filesystem, Archive, Network, AiBackend, Output, SecretStore, Environment], T_AI),
    cap!("ai.test", Ai, ["ai", "test"], [], "console:ai test", [Filesystem, Archive, Network, AiBackend, Output, SecretStore, Environment], T_AI),
    cap!("ai.capabilities", Ai, ["ai", "capabilities"], [], "console:ai capabilities", [Filesystem, Archive, AiBackend, Output], T_AI),
    cap!("ai.estimate", Ai, ["ai", "estimate"], [], "console:ai estimate", [Filesystem, Archive, AiBackend, Output], T_AI),
    cap!("ai.configure", Ai, ["ai", "configure"], [], "console:ai configure", [Filesystem, Clock, Archive, Output], T_AI),
    cap!("ai.package", Ai, ["ai", "package"], [], "console:ai package", [Filesystem, Clock, Archive, Output], T_AI),
    cap!("ai.generate", Ai, ["ai", "generate"], [], "console:ai generate", [Filesystem, Clock, Uuid, Archive, Network, AiBackend, Output, SecretStore, Environment], T_AI_GENERATE),
    cap!("ai.import", Ai, ["ai", "import"], [], "console:ai import", [Filesystem, Clock, Uuid, Archive, Output], T_AI_GENERATE),
    cap!("ai.jobs", Ai, ["ai", "jobs"], [], "console:ai jobs", [Filesystem, Archive, Output], T_AI_GENERATE),
    cap!("ai.cancel", Ai, ["ai", "cancel"], [], "console:ai cancel", [Filesystem, Archive, Output, Cancellation], T_AI_GENERATE),
    // Models
    cap!("model.list", Model, ["model", "list"], [], "console:model list", [Filesystem, Archive, Output], T_MODEL),
    cap!("model.select", Model, ["model", "select"], [], "console:model select", [Filesystem, Archive, Output, AiBackend], T_MODEL),
    cap!("model.inspect", Model, ["model", "inspect"], [], "console:model inspect", [Filesystem, Archive, AiBackend, Output], T_MODEL),
    cap!("model.verify", Model, ["model", "verify"], [], "console:model verify", [Filesystem, Archive, AiBackend, Output], T_MODEL),
    cap!("model.remove-reference", Model, ["model", "remove-reference"], [], "console:model remove-reference", [Filesystem, Archive, Output], T_MODEL),
    // Diagnostics
    cap!("diagnostics.run", Diagnostics, ["diagnostics", "run"], [], "console:diagnostics run", [Filesystem, Environment, AudioCapture, Network, ProcessMetrics, Output], T_DIAGNOSTICS),
    cap!("diagnostics.archive", Diagnostics, ["diagnostics", "archive"], [], "console:diagnostics archive", [Filesystem, Archive, Output], T_DIAGNOSTICS),
    cap!("diagnostics.report", Diagnostics, ["diagnostics", "report"], [], "console:diagnostics report", [Filesystem, Environment, AudioCapture, Network, ProcessMetrics, Output], T_DIAGNOSTICS),
    cap!("diagnostics.providers", Diagnostics, ["diagnostics", "providers"], [], "console:diagnostics providers", [Filesystem, Archive, Network, Output], T_DIAGNOSTICS),
    cap!("diagnostics.graphics", Diagnostics, ["diagnostics", "graphics"], [], "console:diagnostics graphics", [ProcessMetrics, Output], T_DIAGNOSTICS),
    cap!("diagnostics.audio", Diagnostics, ["diagnostics", "audio"], [], "console:diagnostics audio", [AudioCapture, AudioHelper, ProcessMetrics, Output], T_DIAGNOSTICS),
    cap!("diagnostics.network", Diagnostics, ["diagnostics", "network"], [], "console:diagnostics network", [Network, Output], T_DIAGNOSTICS),
    // Benchmarks
    cap!("benchmark.startup", Benchmark, ["benchmark", "startup"], [], "console:benchmark startup", [Clock, ProcessMetrics, Output], T_BENCHMARK),
    cap!("benchmark.memory", Benchmark, ["benchmark", "memory"], [], "console:benchmark memory", [ProcessMetrics, Output], T_BENCHMARK),
    cap!("benchmark.cpu", Benchmark, ["benchmark", "cpu"], [], "console:benchmark cpu", [Clock, ProcessMetrics, Output], T_BENCHMARK),
    cap!("benchmark.indexing", Benchmark, ["benchmark", "indexing"], [], "console:benchmark indexing", [Filesystem, Clock, Archive, Output], T_BENCHMARK),
    cap!("benchmark.rendering", Benchmark, ["benchmark", "rendering"], [], "console:benchmark rendering", [Clock, ProcessMetrics, Output], T_BENCHMARK),
    cap!("benchmark.export", Benchmark, ["benchmark", "export"], [], "console:benchmark export", [Filesystem, Clock, Archive, Output], T_BENCHMARK),
    cap!("benchmark.audio", Benchmark, ["benchmark", "audio"], [], "console:benchmark audio", [Filesystem, Clock, AudioCapture, AudioHelper, MediaProcess, Output], T_BENCHMARK),
    cap!("benchmark.full", Benchmark, ["benchmark", "full"], [], "console:benchmark full", [Filesystem, Clock, Archive, ProcessMetrics, Output], T_BENCHMARK),
    // Recording
    cap!("record.take-list", Record, ["record", "take-list"], [], "console:record take-list", [Filesystem, Archive, Output], T_RECORD),
    cap!("record.configure", Record, ["record", "configure"], [], "console:record configure", [Filesystem, Archive, Output], T_RECORD),
    cap!("record.devices", Record, ["record", "devices"], [], "console:record devices", [AudioCapture, AudioHelper, MediaProcess, Output], T_AUDIO),
    cap!("record.test", Record, ["record", "test"], [], "console:record test", [AudioCapture, AudioHelper, MediaProcess, Clock, Output], T_AUDIO),
    cap!("record.start", Record, ["record", "start"], [], "console:record start", [Filesystem, Clock, Uuid, Archive, AudioCapture, AudioHelper, MediaProcess, TranscriptionBackend, Output, Cancellation], T_RECORD),
    cap!("record.status", Record, ["record", "status"], [], "console:record status", [Filesystem, Archive, Output], T_RECORD),
    cap!("record.pause", Record, ["record", "pause"], [], "console:record pause", [Filesystem, Archive, Output], T_RECORD),
    cap!("record.resume", Record, ["record", "resume"], [], "console:record resume", [Filesystem, Archive, Output], T_RECORD),
    cap!("record.stop", Record, ["record", "stop"], [], "console:record stop", [Filesystem, Archive, Output], T_RECORD),
    cap!("record.recover", Record, ["record", "recover"], [], "console:record recover", [Filesystem, Clock, AudioCapture, Archive, Output], T_RECORD),
    cap!("record.play", Record, ["record", "play"], [], "console:record play", [Filesystem, Archive, MediaProcess, Output], T_AUDIO),
    cap!("record.import", Record, ["record", "import"], [], "console:record import", [Filesystem, Clock, Uuid, Archive, MediaProcess, Output], T_AUDIO),
    cap!("record.export-wav", Record, ["record", "export-wav"], [], "console:record export-wav", [Filesystem, Archive, Output], T_BENCHMARK),
    cap!("record.waveform", Record, ["record", "waveform"], [], "console:record waveform", [Filesystem, Archive, Output], T_BENCHMARK),
    cap!("record.waveform-index-build", Record, ["record", "waveform-index-build"], [], "console:record waveform-index-build", [Filesystem, Clock, Archive, Output], T_BENCHMARK),
    cap!("record.waveform-index-show", Record, ["record", "waveform-index-show"], [], "console:record waveform-index-show", [Filesystem, Archive, Output], T_BENCHMARK),
    cap!("record.mix", Record, ["record", "mix"], [], "console:record mix", [Filesystem, Clock, Uuid, Archive, Output], T_AUDIO),
    cap!("record.take-rename", Record, ["record", "take-rename"], [], "console:record take-rename", [Filesystem, Clock, Archive, Output], T_RECORD),
    cap!("record.take-delete", Record, ["record", "take-delete"], [], "console:record take-delete", [Filesystem, Clock, Archive, Output], T_RECORD),
    cap!("record.take-restore", Record, ["record", "take-restore"], [], "console:record take-restore", [Filesystem, Clock, Archive, Output], T_RECORD),
    cap!("record.track-rename", Record, ["record", "track-rename"], [], "console:record track-rename", [Filesystem, Clock, Archive, Output], T_RECORD),
    // Transcripts
    cap!("transcript.import", Transcript, ["transcript", "import"], [], "console:transcript import", [Filesystem, Clock, Uuid, Archive, Output], T_TRANSCRIPT),
    cap!("transcript.plan", Transcript, ["transcript", "plan"], [], "console:transcript plan", [Filesystem, Archive, Output], T_TRANSCRIPT),
    cap!("transcript.transcribe", Transcript, ["transcript", "transcribe"], ["transcript generate"], "console:transcript transcribe", [Filesystem, Clock, Uuid, Archive, MediaProcess, TranscriptionBackend, Output, Cancellation], T_WHISPER),
    cap!("transcript.refine", Transcript, ["transcript", "refine"], [], "console:transcript refine", [Filesystem, Clock, Uuid, Archive, MediaProcess, TranscriptionBackend, Output, Cancellation], T_WHISPER),
    cap!("transcript.show", Transcript, ["transcript", "show"], [], "console:transcript show", [Filesystem, Archive, Output], T_TRANSCRIPT_RECORDS),
    cap!("transcript.search", Transcript, ["transcript", "search"], [], "console:transcript search", [Filesystem, Archive, Output], T_TRANSCRIPT),
    cap!("transcript.export", Transcript, ["transcript", "export"], [], "console:transcript export", [Filesystem, Archive, Output], T_TRANSCRIPT),
    cap!("transcript.correct", Transcript, ["transcript", "correct"], [], "console:transcript correct", [Filesystem, Clock, Archive, Output], T_TRANSCRIPT_RECORDS),
    cap!("transcript.split", Transcript, ["transcript", "split"], [], "console:transcript split", [Filesystem, Clock, Uuid, Archive, Output], T_TRANSCRIPT_RECORDS),
    cap!("transcript.merge", Transcript, ["transcript", "merge"], [], "console:transcript merge", [Filesystem, Clock, Archive, Output], T_TRANSCRIPT_RECORDS),
    cap!("transcript.history", Transcript, ["transcript", "history"], [], "console:transcript history", [Filesystem, Archive, Output], T_TRANSCRIPT_RECORDS),
    cap!("transcript.restore", Transcript, ["transcript", "restore"], [], "console:transcript restore", [Filesystem, Clock, Archive, Output], T_TRANSCRIPT_RECORDS),
    cap!("transcript.timestamp", Transcript, ["transcript", "timestamp"], [], "console:transcript timestamp", [Filesystem, Clock, Archive, Output], T_TRANSCRIPT_RECORDS),
    cap!("transcript.verify", Transcript, ["transcript", "verify"], [], "console:transcript verify", [Filesystem, Clock, Archive, Output], T_TRANSCRIPT_RECORDS),
    cap!("transcript.speaker", Transcript, ["transcript", "speaker"], [], "console:transcript speaker", [Filesystem, Clock, Archive, Output], T_TRANSCRIPT_RECORDS),
];
