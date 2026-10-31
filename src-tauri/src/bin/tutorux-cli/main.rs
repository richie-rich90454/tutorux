use std::io::Write;

use tutorux_desktop::core::cli::{execute_cli, Cancellation, CliOutput, NoCancellation};

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
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let mut output = StdioOutput;
    let code = execute_cli(&arguments, &mut output, &SignalCancellation);
    std::process::exit(code);
}
