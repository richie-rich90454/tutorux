use serde_json::{json, Value};

use crate::core::cli::{emit, CliOutput, CliResult, ParsedArguments};

pub fn run_ai_providers(args: ParsedArguments, output: &mut dyn CliOutput) -> CliResult<i32> {
    let providers = [
        ("ollama", "Ollama (local)", "local"),
        ("openai", "OpenAI", "cloud"),
        ("anthropic", "Anthropic", "cloud"),
        ("google", "Google Gemini", "cloud"),
        ("replicate", "Replicate", "cloud"),
        ("local-gguf", "Local GGUF", "local"),
    ];
    let rows: Vec<Value> = providers
        .iter()
        .map(|(id, name, status)| {
            json!({
                "provider_id": id,
                "provider": name,
                "status": status,
                "catalog": {
                    "id": id,
                    "name": name,
                },
            })
        })
        .collect();
    let summary = providers
        .iter()
        .map(|(id, name, status)| format!("{id}  {name}  {status}"))
        .collect::<Vec<_>>()
        .join("\n");
    emit(output, Value::Array(rows), &summary, args.json());
    Ok(0)
}
