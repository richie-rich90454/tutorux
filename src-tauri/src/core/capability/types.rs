#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Family {
    Cli,
    Archive,
    Student,
    Session,
    Journal,
    Annotation,
    Asset,
    Evidence,
    Guide,
    Template,
    Settings,
    Ai,
    Model,
    Diagnostics,
    Benchmark,
    Record,
    Transcript,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Port {
    Filesystem,
    Clock,
    Uuid,
    Crypto,
    SecretStore,
    Environment,
    Archive,
    Output,
    Cancellation,
    AiBackend,
    Network,
    AudioCapture,
    AudioHelper,
    MediaProcess,
    TranscriptionBackend,
    ProcessMetrics,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capability {
    pub id: &'static str,
    pub family: Family,
    /// Canonical CLI path, for example `["student", "create"]`.
    pub cli: &'static [&'static str],
    /// Additional accepted CLI spellings, for example `["journal entry create"]`.
    pub cli_aliases: &'static [&'static str],
    /// Desktop mapping. Console commands reach the same router in-process.
    pub desktop: &'static str,
    pub ports: &'static [Port],
    pub integration_test: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryIssueKind {
    MissingId,
    MissingCliMapping,
    MissingDesktopMapping,
    MissingIntegrationTest,
    MissingPorts,
    DuplicateId,
    DuplicateCliMapping,
    InvalidCliMapping,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryIssue {
    pub capability_id: String,
    pub kind: RegistryIssueKind,
    pub detail: String,
}

pub const KNOWN_CLI_GROUPS: &[&str] = &[
    "help",
    "version",
    "archive",
    "student",
    "session",
    "journal",
    "annotation",
    "asset",
    "evidence",
    "guide",
    "template",
    "settings",
    "ai",
    "model",
    "diagnostics",
    "benchmark",
    "record",
    "transcript",
];
