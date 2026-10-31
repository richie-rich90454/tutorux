use crate::core::cli::{CliContext, CliOutput, CliResult, ParsedArguments};

mod ai;
mod benchmark;
mod diagnostics;
mod model;
mod providers;

pub use benchmark::run_benchmark_command;
pub use diagnostics::run_diagnostics_command;
pub use providers::run_ai_providers;

pub fn run_record_ai_command(
    group: &str,
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    if group == "model" {
        return model::run_model(action, args, output, path, context);
    }
    ai::run(action, args, output, path, context)
}
