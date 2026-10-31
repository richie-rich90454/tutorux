use serde::Serialize;
use tauri::{AppHandle, Emitter};
use crate::core::cli::CliOutput;

const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const OUTPUT_CHUNK_BYTES: usize = 8 * 1024;
const OUTPUT_TRUNCATION_NOTICE: &str = "\n[Output truncated at 256 KiB.]\n";
const CONSOLE_OUTPUT_EVENT: &str = "tutorux:console-output";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConsoleOutput {
    run_id: String,
    text: String,
}

pub(super) struct ConsoleOutputSink {
    app: AppHandle,
    run_id: String,
    written: usize,
    truncated: bool,
}

impl ConsoleOutputSink {
    pub(super) fn new(app: AppHandle, run_id: &str) -> Self {
        Self {
            app,
            run_id: run_id.to_owned(),
            written: 0,
            truncated: false,
        }
    }

    fn push(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let limit = MAX_OUTPUT_BYTES.saturating_sub(OUTPUT_TRUNCATION_NOTICE.len());
        let remaining = limit.saturating_sub(self.written);
        if remaining == 0 {
            self.truncate();
            return;
        }
        let mut end = text.len().min(remaining);
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == 0 {
            self.truncate();
            return;
        }
        let accepted = &text[..end];
        let mut start = 0;
        while start < accepted.len() {
            let mut stop = (start + OUTPUT_CHUNK_BYTES).min(accepted.len());
            while stop > start && !accepted.is_char_boundary(stop) {
                stop -= 1;
            }
            self.emit(&accepted[start..stop]);
            start = stop;
        }
        self.written += end;
        if end < text.len() {
            self.truncate();
        }
    }

    fn truncate(&mut self) {
        if self.truncated {
            return;
        }
        self.truncated = true;
        self.emit(OUTPUT_TRUNCATION_NOTICE);
    }

    fn emit(&self, text: &str) {
        let _ = self.app.emit(
            CONSOLE_OUTPUT_EVENT,
            ConsoleOutput {
                run_id: self.run_id.clone(),
                text: text.to_owned(),
            },
        );
    }
}

impl CliOutput for ConsoleOutputSink {
    fn stdout(&mut self, message: &str) {
        self.push(message);
        self.push("\n");
    }

    fn stderr(&mut self, message: &str) {
        self.push(message);
        self.push("\n");
    }
}
