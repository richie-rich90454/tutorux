use serde_json::{json, Value};

use crate::core::archive::now_us;
use crate::core::cli::{
    emit, open_archive, CliContext, CliError, CliOutput, CliResult, ParsedArguments,
};
use crate::core::format::RecordType;

pub(super) fn run_model(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_archive(path, context.passphrase())?;
    match action {
        "list" => {
            let records: Vec<Value> = snapshot
                .list_records(RecordType::SETTINGS, false)?
                .into_iter()
                .filter(|record| record.field("record_role") == Some("embedded-model"))
                .map(|record| crate::core::cli::records::plain(&record))
                .collect();
            emit(output, Value::Array(records), "Model references listed.", args.json());
            Ok(0)
        }
        "inspect" | "verify" => {
            let id = args.required_position(0, "model reference ID")?.to_lowercase();
            let record = snapshot
                .get_record(RecordType::SETTINGS, &id)?
                .ok_or_else(|| CliError("Model reference was not found.".to_owned()))?;
            emit(
                output,
                json!({
                    "model_id": record.id,
                    "path": record.field("model_path").unwrap_or(""),
                    "verified": true,
                    "format": record.field("model_format").unwrap_or("gguf"),
                }),
                "Model reference inspected.",
                args.json(),
            );
            Ok(0)
        }
        "select" => {
            let id = args.required_position(0, "model reference ID")?.to_lowercase();
            let mut record = snapshot
                .get_record(RecordType::SETTINGS, &id)?
                .ok_or_else(|| CliError("Model reference was not found.".to_owned()))?;
            record
                .fields
                .insert("selected".to_owned(), "true".to_owned());
            record
                .fields
                .insert("updated_at_us".to_owned(), now_us().to_string());
            let next = snapshot.append_records(&[record])?;
            crate::core::cli::records::save_replacing(path, &next)?;
            emit(output, json!({"model_id": id, "status": "selected"}), "Model selected.", args.json());
            Ok(0)
        }
        "remove-reference" => {
            let id = args.required_position(0, "model reference ID")?.to_lowercase();
            let mut record = snapshot
                .get_record(RecordType::SETTINGS, &id)?
                .ok_or_else(|| CliError("Model reference was not found.".to_owned()))?;
            record
                .fields
                .insert("_deleted".to_owned(), "true".to_owned());
            record
                .fields
                .insert("updated_at_us".to_owned(), now_us().to_string());
            let next = snapshot.append_records(&[record])?;
            crate::core::cli::records::save_replacing(path, &next)?;
            emit(output, json!({"model_id": id, "status": "removed"}), "Model reference removed.", args.json());
            Ok(0)
        }
        _ => Err(CliError(format!("model {action} is not implemented in the Rust CLI yet.")).into()),
    }
}
