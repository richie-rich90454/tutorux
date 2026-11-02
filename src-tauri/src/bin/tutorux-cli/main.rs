use std::io::Write;

use tutorux_desktop::core::cli::{execute_cli, Cancellation, CliOutput};

struct StdioOutput;

impl CliOutput for StdioOutput {
    fn stdout(&mut self, message: &str) {
        println!("{message}");
    }

    fn stderr(&mut self, message: &str) {
        let _ = writeln!(std::io::stderr(), "{message}");
    }
}

struct SignalCancellation;

impl Cancellation for SignalCancellation {
    fn is_cancelled(&self) -> bool {
        false
    }
}

fn main() {
    let arguments: Vec<String> = match std::env::args_os()
        .skip(1)
        .map(|argument| argument.into_string())
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(arguments) => arguments,
        Err(_) => {
            eprintln!("tutorux: arguments must be valid UTF-8");
            std::process::exit(2);
        }
    };
    let mut output = StdioOutput;
    let code = execute_cli(&arguments, &mut output, &SignalCancellation);
    std::process::exit(code);
}
