use std::collections::BTreeSet;

use crate::core::cli::{CliError, CliResult, ParsedArguments};
use crate::core::format::valid_uuid;
use crate::core::sanitize::SanitizedCopyOptions;

fn id_set(args: &ParsedArguments, name: &str) -> CliResult<BTreeSet<String>> {
    let Some(value) = args.option(name) else {
        return Ok(BTreeSet::new());
    };
    let mut ids = BTreeSet::new();
    if value.trim().is_empty() {
        return Ok(ids);
    }
    for raw in value.split(',').map(str::trim) {
        let id = raw.to_lowercase();
        if !valid_uuid(&id) {
            return Err(CliError(format!("Option '--{name}' contains an invalid UUID.")).into());
        }
        if !ids.insert(id) {
            return Err(CliError(format!("Option '--{name}' contains a duplicate UUID.")).into());
        }
    }
    Ok(ids)
}

pub(super) fn options(args: &ParsedArguments) -> CliResult<SanitizedCopyOptions> {
    let include_recording_tracks = id_set(args, "include-recording-tracks")?;
    let exclude_recording_tracks = id_set(args, "exclude-recording-tracks")?;
    Ok(SanitizedCopyOptions {
        include_students: id_set(args, "include-students")?,
        exclude_students: id_set(args, "exclude-students")?,
        include_sessions: id_set(args, "include-sessions")?,
        exclude_sessions: id_set(args, "exclude-sessions")?,
        include_recordings: args.flag("include-recordings")
            || !include_recording_tracks.is_empty()
            || !exclude_recording_tracks.is_empty(),
        include_recording_tracks,
        exclude_recording_tracks,
        include_private_annotations: args.flag("include-private-annotations"),
        include_generation_logs: args.flag("include-generation-logs"),
        include_credentials: args.flag("include-credentials"),
    })
}
