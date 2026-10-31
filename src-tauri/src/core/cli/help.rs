pub const HELP: &str = r#"Tutorux — local-first tutoring archive tools

Usage:
  tutorux archive init <file.tux> --name <name> [--description <text>] [--new-passphrase-env <name>]
  tutorux archive discover|list [--directory <directory>] [--json]
    scans immediate regular .tux files; locked and unsupported candidates show limited metadata
  tutorux archive rename <file.tux> --name <name> [--passphrase-env <name>]
  tutorux archive encrypt <file.tux> --new-passphrase-env <name>
  tutorux archive unlock <file.tux> [--passphrase-env <name>] [--json]
  tutorux --passphrase-env <current-name> archive change-passphrase <file.tux> --new-passphrase-env <new-name>
  tutorux archive info <file.tux> [--json]
  tutorux archive verify <file.tux> [--full] [--history] [--passphrase-env <name>] [--json]
  tutorux archive backup|copy <file.tux> --output <copy.tux> --confirm-sensitive [--json]
  tutorux archive recover <file.tux> [--apply] [--json]
  tutorux archive compact <file.tux> [--prune-unreferenced-assets] [--apply] [--json]
  tutorux archive purge-trash <file.tux> [--apply] [--json]
  tutorux archive backfill-indexes <file.tux> [--apply] [--json]
  tutorux archive repair <file.tux> --output <copy.tux> --confirm-sensitive [--json]
  tutorux archive rebuild-index <file.tux> --output <new-copy.tux> --confirm-sensitive [--json]
    rebuilds only fully published unencrypted v1 logs with intact record headers and known record types
  tutorux archive sanitize <file.tux> --output <copy.tux> [selection options] [--new-passphrase-env <name>]
    preview first; confirm with --confirm-sensitive --expected-generation N --expected-selection SHA256 --expected-output FILE --expected-encrypted-output yes|no
    --include-students UUID,... --exclude-students UUID,... --include-sessions UUID,... --exclude-sessions UUID,...
    --include-recordings | --include-recording-tracks UUID,... | --exclude-recording-tracks UUID,...
    --include-private-annotations --include-generation-logs --include-credentials
    encrypted sources and credential-inclusive copies require --new-passphrase-env on confirmation
  tutorux --archive <file.tux> student create --name <name> [--grade <grade>] [--subjects <text>] [--objectives <text>] [--notes <text>] [--difficulties <text>] [--demonstrated-improvements <text>] [--preferred-guide-template <id>]
  tutorux --archive <file.tux> student list [--include-deleted] [--json]
  tutorux --archive <file.tux> student show <uuid> [--json]
  tutorux --archive <file.tux> student update <uuid> [--name <name>] [--grade <grade>] [--subjects <text>] [--objectives <text>] [--difficulties <text>] [--demonstrated-improvements <text>] [--notes|--tutor-notes <text>] [--preferred-guide-template <id>]
  tutorux --archive <file.tux> student delete|restore <uuid>
  tutorux --archive <file.tux> student history <student-id> [--json]
  tutorux --archive <file.tux> student progress <student-id> [--json]
  tutorux --archive <file.tux> student progress-review <student-id> --skill <name> --classification <value> --evidence-ids <uuid,...> --reviewed-by <name> [--note <text>]
  tutorux --archive <file.tux> session create [--title <title>] [--subject <subject>] [--student-id <uuid>] [--entry-id <uuid>]
    [--type notes-only|record-audio|import-recording] [--language auto|code] [--guide-template <id>]
    [--recording-source none|microphone|system-audio|both|application|imported-file]
  tutorux --archive <file.tux> session list [--student-id <uuid>] [--entry-id <uuid>] [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--archived|--unarchived] [--include-deleted] [--json]
  tutorux --archive <file.tux> session show|verify <uuid> [--json]
  tutorux --archive <file.tux> session update <uuid> [--title <title>] [--subject <subject>] [--objectives <text>] [--student-id <uuid>] [--entry-id <uuid>] [--notes <text>]
  tutorux --archive <file.tux> session clone <uuid> [--title <title>] [--type notes-only|record-audio|import-recording]
  tutorux --archive <file.tux> session export <uuid> --output <package.tux> [--force]
  tutorux --archive <file.tux> session import <package.tux>|--input <package.tux> [--student-id <uuid>]
  tutorux --archive <file.tux> session archive|unarchive <uuid>
  tutorux --archive <file.tux> session start|complete|review|resume <uuid>
  tutorux --archive <file.tux> session recover --session <uuid> [--json]
  tutorux --archive <file.tux> session delete <uuid> [--dry-run] [--confirm-scope --scope-token <token>]
  tutorux --archive <file.tux> session restore <uuid>
  tutorux --archive <file.tux> journal create --title <title> --date <YYYY-MM-DD> [--collection-ids <uuid,...>] [--tag-ids <uuid,...>]
  tutorux --archive <file.tux> journal update <entry-id> [--title <title>] [--date <YYYY-MM-DD>] [--notes <text>] [--collection-ids <uuid,...>] [--tag-ids <uuid,...>]
  tutorux --archive <file.tux> journal list|entry list [--collection-id <uuid>] [--tag-id <uuid>] [--from <date>] [--to <date>] [--has-sessions true|false] [--query <text>] [--json]
  tutorux --archive <file.tux> journal search --query <text> [--collection-id <uuid>] [--tag-id <uuid>] [--from <date>] [--to <date>] [--has-sessions true|false] [--json]
  tutorux --archive <file.tux> journal document show|update|add-block|remove-block|restore-block|move-block <document-id> [options]
  tutorux --archive <file.tux> journal collection|tag list|create|show|update|delete|restore
  tutorux --archive <file.tux> annotation add --session <uuid> --type <type> --at <time> --text <text> [--end <time>] [--priority low|normal|high|critical]
  tutorux --archive <file.tux> annotation list [--session <uuid>] [--json]
  tutorux --archive <file.tux> annotation update <id> [--text <text>] [--title <title>] [--start <time>] [--end <time>]
  tutorux --archive <file.tux> annotation remove|prioritize|duplicate <id>
  tutorux --archive <file.tux> annotation history <id> [--limit <1..10000>]
  tutorux --archive <file.tux> annotation restore <id> --revision <history-index>
  tutorux --archive <file.tux> annotation merge <id> <id> [<id>...] [--separator <text>]
  tutorux --archive <file.tux> annotation split <id> --before <text> --after <text> [--at <time>]
  tutorux --archive <file.tux> annotation link|unlink <id> --to asset|evidence --target-id <uuid>
  tutorux --archive <file.tux> asset add <file> [--session <uuid>] | import --input <file> [--session <uuid>]
    [--capture-source browser-microphone --consent [--capture-consent-at-us <us>]]
  tutorux --archive <file.tux> asset import-folder <directory> [--session <uuid>]
    [--capture-source browser-microphone --consent [--capture-consent-at-us <us>]]
  tutorux --archive <file.tux> asset list [--session <uuid>] [--include-deleted] [--json]
  tutorux --archive <file.tux> asset show|preview|verify|remove|restore <id> [--json]
  tutorux --archive <file.tux> asset update <id> [--filename <name>] [--description <text>]
  tutorux --archive <file.tux> asset history <id> [--limit <1..10000>] [--json]
  tutorux --archive <file.tux> asset restore <id> --revision <history-index>
  tutorux --archive <file.tux> asset extract|export <id> --output <file>
  tutorux --archive <file.tux> asset link|unlink <id> --to annotation|transcript --target-id <uuid>
  tutorux --archive <file.tux> evidence extract --session <uuid>
  tutorux --archive <file.tux> evidence list|review [--session <uuid>] [--json]
  tutorux --archive <file.tux> evidence create --session <uuid> --source-segment <uuid> --type <type> --title <title> --content <text>
  tutorux --archive <file.tux> evidence approve|reject|verify|show|update|delete|restore <id>
  tutorux --archive <file.tux> evidence link --from <id> --to <id> --relationship <type>
  tutorux --archive <file.tux> evidence unlink <edge-id>
  tutorux --archive <file.tux> evidence edges --session <uuid>
  tutorux --archive <file.tux> evidence graph --session <uuid> [--json]
  tutorux --archive <file.tux> guide create --session <uuid> [--template <id>] [--title <title>]
  tutorux --archive <file.tux> guide generate (--session <uuid>|--entry-id <uuid>) [--template <id|auto>] [--title <title>] [--include-entry-evidence] [--json]
  tutorux --archive <file.tux> guide regenerate <id> [--template <id|auto>] [--title <title>] [--include-entry-evidence|--session-only] [--json]
    [--section-index <index>] regenerates only the matching section
  tutorux --archive <file.tux> guide list [--session <uuid>] [--entry-id <uuid>] [--include-deleted] [--json]
  tutorux --archive <file.tux> guide show|approve|trash|restore|history <id>
  tutorux --archive <file.tux> guide compare <id> [--json]
  tutorux --archive <file.tux> guide validate <id> [--revision <index>] [--json]
  tutorux --archive <file.tux> guide update <id> [--title <title>]
  tutorux --archive <file.tux> guide add-section <id> --heading <heading> [--text <text>]
  tutorux --archive <file.tux> guide edit <id> [--title <title>] [--section-index <index> --heading <heading>|--block-index <index> --text <text>|--kind <kind>|--sources <ids>|--clear-sources|--mark-reviewed]
  tutorux --archive <file.tux> guide move-section <id> --from <index> --to <index>
  tutorux --archive <file.tux> guide move-block <id> --section-index <index> --from <index> --to <index>
  tutorux --archive <file.tux> guide remove-section <id> --section-index <index>
  tutorux --archive <file.tux> guide add-block|update-block|remove-block <id> --section-index <index> [--block-index <index>]
  tutorux --archive <file.tux> guide export <id> --output <file> [--format markdown|html|json|docx|pdf] [--revision <index>]
  tutorux --archive <file.tux> template list|show [<id>]
  tutorux --archive <file.tux> template create --name <name> --sections <heading;heading;...>
  tutorux --archive <file.tux> template update <id> [--name <name>] [--sections <headings>]
  tutorux --archive <file.tux> template delete|restore <id>
  tutorux --archive <file.tux> template import --input <file.json>
  tutorux --archive <file.tux> template export <id> --output <file.json>
  tutorux --archive <file.tux> settings list|get <key>|set --key <key> --value <value>|reset [--key <key>]
  tutorux --archive <file.tux> settings import --input <file>|copy-to-archive --source-archive <file> [--key <key>]
  tutorux --archive <file.tux> settings credential-list|credential-remove --key <key>
    Sensitive settings require --store-credential --value-env <name> and an encrypted archive.
  tutorux ai providers [--json]
  tutorux --archive <file.tux> ai context --session <uuid> [--token-budget <n>] [--max-item-tokens <n>]
  tutorux --archive <file.tux> ai models|test --provider <id> [--refresh] [--api-key-env <name>]
  tutorux --archive <file.tux> ai capabilities --provider <id> --model <id>
  tutorux --archive <file.tux> ai estimate --provider ollama --job <uuid> [--model <id>] [--max-tokens <1..1000000>] [--endpoint <loopback-url>] [--json]
  tutorux --archive <file.tux> ai configure --provider <id> [--endpoint <url>] [--model <id>]
  tutorux --archive <file.tux> ai package --session <uuid> [--template <id|auto>] [--image-ids <uuid,...>] [--output <file>]
  tutorux --archive <file.tux> ai generate --job <uuid> --provider <id> [--model <id>] [--api-key-env <name>] [--max-tokens <n>] [--request-output <file>] [--confirm-outbound --confirm-hash <sha256>]
  tutorux --archive <file.tux> ai import --session <uuid> --input <file> [--template <id>]
  tutorux --archive <file.tux> ai jobs|cancel <job-id> [--json]
  tutorux --archive <file.tux> model list|select|inspect|verify|remove-reference
  tutorux diagnostics run|archive|report [--full] | providers | graphics | audio | network
    diagnostics audio inspects native endpoint format, sample rate, and channel count without opening a stream
  tutorux benchmark startup|memory|cpu|indexing|rendering|export|audio|full
  tutorux --archive <file.tux> record take-list --session <uuid> [--include-deleted] [--json]
  tutorux --archive <file.tux> record configure [--microphone <default|id>] [--playback <default|id>] [--durability <default|maximum|reduced-write>]
  Live recording prefers the bundled native audio helper for microphone and system audio; FFmpeg is the fallback and is not bundled.
  Playback requires ffplay from a host FFmpeg distribution; the CLI does not bundle it.
  tutorux record devices [--ffmpeg <executable>] [--json]
    lists native microphone/system inputs, FFmpeg endpoints, and native process-audio targets
  tutorux record test [--source microphone|system-audio|loopback|application|both] [--device <id>]
    [--microphone <id>] [--playback <id>] [--application <id>] [--system-audio] [--ffmpeg <executable>]
    opens a short input probe and measures signal levels; no recording is saved
  tutorux --archive <file.tux> record start --session <uuid> --consent
    [--source microphone|system-audio|both|application]
    [--device <id>|--microphone <id>|--playback <id>|--application <id>] [--system-audio]
    [--ffmpeg <executable>] [--input-format pulse|alsa] [--duration-seconds <n>]
    [--confirmed-by <label>] [--detach] [--live-transcribe --whisper <executable> --model <file>
      --consent-local-audio [--language auto|code] [--threads <1..64>]
      [--window-seconds <1..27>] [--diarize]]
    --source application records one process; --source both --application <id> records microphone and process audio
    Native microphone/system/application capture uses the audio helper; FFmpeg is the fallback. Standalone users can set TUTORUX_AUDIO_HELPER or run npm run build:audio-helper
  tutorux --archive <file.tux> record status [--session <uuid>] | pause|resume|stop --session <uuid>
    Detached recording workers can be checked, paused, resumed, or stopped from another CLI process.
  tutorux --archive <file.tux> record recover --session <uuid> [--json]
  tutorux --archive <file.tux> record play --session <uuid> [--track <uuid>]
    [--start-frame <n>|--start-us <n>] [--duration-frames <n>|--duration-us <n>] [--ffplay <executable>]
  tutorux --archive <file.tux> record import --session <uuid> --input <file.wav|flac|mp3|m4a> [--additional-track] [--ffmpeg <executable>]
  tutorux --archive <file.tux> record export-wav --session <uuid> --output <file.wav> [--track <uuid>] [--fill-gaps] [--overwrite]
  tutorux --archive <file.tux> record waveform --session <uuid> [--track <uuid>] [--buckets <n>]
  tutorux --archive <file.tux> record waveform-index-build --session <uuid> [--track <uuid>]
  tutorux --archive <file.tux> record waveform-index-show --session <uuid> [--track <uuid>] [--level <n>] [--json]
  tutorux --archive <file.tux> record mix --session <uuid> --take <uuid> --tracks <uuid,uuid,...> [--label <name>]
  tutorux --archive <file.tux> record take-rename --session <uuid> --take <uuid> --label <name>
  tutorux --archive <file.tux> record take-delete|take-restore --session <uuid> --take <uuid>
  tutorux --archive <file.tux> record track-rename --session <uuid> --track <uuid> --label <name>
  tutorux --archive <file.tux> transcript import --session <uuid> --input <file> [--format auto|text|srt|vtt]
  tutorux --archive <file.tux> transcript plan --session <uuid> [--track <uuid>] [--threads <n>] [--model-memory-mb <n>] [--available-memory-mb <n>]
  tutorux --archive <file.tux> annotation plan --session <uuid> [--track <uuid>] [--threads <n>] [--model-memory-mb <n>] [--available-memory-mb <n>]
  tutorux --archive <file.tux> transcript transcribe|generate|refine --session <uuid> --track <uuid> --whisper <executable> --model <model> --consent-local-audio [--language auto|code] [--start time] [--end time] [--diarize] [--json]
    generate is an alias for transcribe
  tutorux --archive <file.tux> transcript show --session <uuid> [--json]
  tutorux --archive <file.tux> transcript search --session <uuid> --query <text> [--json]
  tutorux --archive <file.tux> transcript export --session <uuid> --output <file> [--format text|srt|vtt|json]
  tutorux --archive <file.tux> transcript correct <segment-id> --text <replacement>
  tutorux --archive <file.tux> transcript split <segment-id> --before <text> --after <text> [--at <time>]
  tutorux --archive <file.tux> transcript merge <segment-id> <segment-id>... [--separator <text>]
  tutorux --archive <file.tux> transcript history <segment-id> [--limit <1..10000>]
  tutorux --archive <file.tux> transcript restore <segment-id> --revision <history-index>
  tutorux --archive <file.tux> transcript timestamp <segment-id> --start <time> --end <time>
  tutorux --archive <file.tux> transcript verify <segment-id> [--state human-verified|provisional|needs-review]
  tutorux --archive <file.tux> transcript speaker <segment-id> --name <label> | --speaker <label> | --unknown

Global options:
  --archive <path>  Select the archive for record commands
  --directory <path>  Select the immediate directory for archive discovery (defaults to current directory)
  --passphrase-env <name>  Read an encrypted archive passphrase from an environment variable
  --json            Print machine-readable JSON
  --help            Show this help
  --version         Show the application version"#;
