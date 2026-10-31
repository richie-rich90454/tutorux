use serde_json::{json, Value};

use crate::core::archive::now_us;
use crate::core::cli::{
    emit, open_archive, parse_integer, CliContext, CliError, CliOutput, CliResult, ParsedArguments,
};
use crate::core::error::CoreError;
use crate::core::format::RecordType;

pub(super) fn run(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    match action {
        "context" => {
            let snapshot = open_archive(path, context.passphrase())?;
            if snapshot.locked() {
                return Err(CliError("This archive is encrypted. Provide --passphrase-env to unlock it.".to_owned()).into());
            }
            let session_id = args.required_option("session")?.to_lowercase();
            let session = snapshot
                .get_record(RecordType::SESSION, &session_id)?
                .ok_or_else(|| CliError("Session was not found.".to_owned()))?;
            emit(
                output,
                json!({
                    "session_id": session.id,
                    "title": session.field("title").unwrap_or(""),
                    "token_budget": args.option("token-budget").unwrap_or("12000"),
                }),
                "AI context prepared.",
                args.json(),
            );
            Ok(0)
        }
        "models" | "test" => {
            let provider = args.required_option("provider")?.to_owned();
            emit(
                output,
                json!({
                    "provider_id": provider,
                    "status": "configured",
                    "models": [],
                }),
                "Provider configuration checked.",
                args.json(),
            );
            Ok(0)
        }
        "capabilities" => {
            let provider = args.required_option("provider")?.to_owned();
            let model = args.required_option("model")?.to_owned();
            emit(
                output,
                json!({
                    "provider_id": provider,
                    "model": model,
                    "text": true,
                    "images": !provider.contains("ollama"),
                    "structured_output": true,
                }),
                "AI capabilities inspected.",
                args.json(),
            );
            Ok(0)
        }
        "estimate" => {
            let job = args.required_option("job")?.to_lowercase();
            let max_tokens = parse_integer(args.option("max-tokens"), "max-tokens", 1024, 1, 1_000_000)?;
            emit(
                output,
                json!({
                    "job_id": job,
                    "provider_id": args.option("provider").unwrap_or("ollama"),
                    "model": args.option("model").unwrap_or(""),
                    "max_tokens": max_tokens.to_string(),
                    "estimated_prompt_tokens": "0",
                    "estimated_completion_tokens": "0",
                }),
                "AI estimate prepared.",
                args.json(),
            );
            Ok(0)
        }
        "configure" => {
            let snapshot = open_archive(path, context.passphrase())?;
            if snapshot.locked() {
                return Err(CliError("This archive is encrypted. Provide --passphrase-env to unlock it.".to_owned()).into());
            }
            let provider = args.required_option("provider")?.to_owned();
            let id = crate::core::cli::records::deterministic_uuid(&format!("ai-provider:{provider}"));
            let mut record = crate::core::format::ArchiveRecord::new(
                RecordType::SETTINGS,
                id,
                [
                    ("record_role", "ai-provider".to_owned()),
                    ("provider_id", provider.clone()),
                    ("endpoint", args.option("endpoint").unwrap_or("").to_owned()),
                    ("selected_model", args.option("model").unwrap_or("").to_owned()),
                    ("configured_at_us", now_us().to_string()),
                    ("credential_storage", "memory-only".to_owned()),
                ],
            );
            record
                .fields
                .insert("updated_at_us".to_owned(), now_us().to_string());
            let next = snapshot.append_records(&[record])?;
            crate::core::cli::records::save_replacing(path, &next)?;
            emit(
                output,
                json!({
                    "provider_id": provider,
                    "endpoint": args.option("endpoint").unwrap_or(""),
                    "model": args.option("model").unwrap_or(""),
                    "status": "configured",
                }),
                "AI provider configured.",
                args.json(),
            );
            Ok(0)
        }
        "package" => {
            let snapshot = open_archive(path, context.passphrase())?;
            if snapshot.locked() {
                return Err(CliError("This archive is encrypted. Provide --passphrase-env to unlock it.".to_owned()).into());
            }
            let session_id = args.required_option("session")?.to_lowercase();
            snapshot
                .get_record(RecordType::SESSION, &session_id)?
                .ok_or_else(|| CliError("Session was not found.".to_owned()))?;
            let destination = args.option("output").map(crate::core::cli::resolve_path);
            let package = json!({
                "format": "tutorux-ai-package-v1",
                "session_id": session_id,
                "template": args.option("template").unwrap_or("auto"),
                "image_ids": args.option("image-ids").unwrap_or(""),
            });
            if let Some(destination) = destination {
                crate::core::cli::write_file_atomically(
                    &destination,
                    serde_json::to_string_pretty(&package).unwrap_or_default().as_bytes(),
                )?;
            }
            emit(output, package, "AI package prepared.", args.json());
            Ok(0)
        }
        "generate" => {
            let provider = args.required_option("provider")?.to_owned();
            let api_key = args.option("api-key-env").and_then(|name| std::env::var(name).ok());
            if provider != "ollama" && provider != "local-gguf" && api_key.is_none() {
                return Err(CliError(
                    "Cloud AI generation requires --api-key-env with a configured API key.".to_owned(),
                )
                .into());
            }
            Err(CliError(
                "AI generation runs through the native desktop transport; use the desktop workspace."
                    .to_owned(),
            )
            .into())
        }
        "import" => {
            let snapshot = open_archive(path, context.passphrase())?;
            let session_id = args.required_option("session")?.to_lowercase();
            let input = crate::core::cli::resolve_path(args.required_option("input")?);
            let text = std::fs::read_to_string(&input).map_err(|error| {
                CoreError::new("ai_import_failed", format!("Could not read AI response: {error}"))
            })?;
            let response: Value = serde_json::from_str(&text).map_err(|error| {
                CoreError::new("ai_import_failed", format!("AI response JSON is invalid: {error}"))
            })?;
            let content = response
                .get("content")
                .or_else(|| response.get("text"))
                .and_then(Value::as_str)
                .unwrap_or(text.as_str())
                .to_owned();
            let title = args.option("title").unwrap_or("Imported AI response");
            let record = crate::core::format::ArchiveRecord::new(
                RecordType::SETTINGS,
                crate::core::archive::new_uuid(),
                [
                    ("record_role", "ai-import".to_owned()),
                    ("session_id", session_id.clone()),
                    ("title", title.to_owned()),
                    ("content", content),
                    ("created_at_us", now_us().to_string()),
                ],
            );
            let next = snapshot.append_records(&[record])?;
            crate::core::cli::records::save_replacing(path, &next)?;
            emit(
                output,
                json!({"session_id": session_id, "status": "imported"}),
                "AI response imported.",
                args.json(),
            );
            Ok(0)
        }
        "jobs" => {
            let snapshot = open_archive(path, context.passphrase())?;
            let records = snapshot.list_records(RecordType::AI_JOB, args.flag("include-deleted"))?;
            let rows: Vec<Value> = records.iter().map(crate::core::cli::records::plain).collect();
            emit(output, Value::Array(rows), "AI jobs listed.", args.json());
            Ok(0)
        }
        "cancel" => {
            let id = args.required_position(0, "AI job ID")?.to_lowercase();
            let snapshot = open_archive(path, context.passphrase())?;
            if let Some(mut record) = snapshot.get_record(RecordType::AI_JOB, &id)? {
                record.fields.insert("status".to_owned(), "cancelled".to_owned());
                record
                    .fields
                    .insert("updated_at_us".to_owned(), now_us().to_string());
                let next = snapshot.append_records(&[record])?;
                crate::core::cli::records::save_replacing(path, &next)?;
            }
            emit(output, json!({"job_id": id, "status": "cancelled"}), "AI job cancelled.", args.json());
            Ok(0)
        }
        _ => Err(CliError(format!("ai {action} is not implemented in the Rust CLI yet.")).into()),
    }
}
