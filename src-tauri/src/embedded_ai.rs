use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use zeroize::Zeroize;

const MAX_PROMPT_BYTES: usize = 4 * 1024 * 1024;
const MAX_OUTPUT_TOKENS: u32 = 8_192;
const HELPER_STOPPED: &str = "The local embedded AI helper stopped unexpectedly.";

#[derive(Clone, Default)]
pub(crate) struct EmbeddedAiState {
    process: Arc<Mutex<Option<Sidecar>>>,
    next_id: Arc<AtomicU64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddedModelInfo {
    authorization_token: String,
    model_id: String,
    name: String,
    architecture: String,
    file_size_bytes: u64,
    tensor_count: u64,
    estimated_memory_bytes: u64,
    context_tokens: u32,
    maximum_context_tokens: u32,
    maximum_cpu_threads: u32,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddedModelStatus {
    loaded: bool,
    model_id: Option<String>,
    name: Option<String>,
    path_name: Option<String>,
    context_tokens: Option<u32>,
    cpu_threads: Option<u32>,
    memory_estimate_bytes: Option<u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddedGenerationResult {
    generated_tokens: u32,
    response_bytes: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddedGenerationChunk {
    text: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddedGenerationRequest {
    request_id: String,
    model_id: String,
    system_prompt: String,
    user_content: String,
    maximum_output_tokens: u32,
}

impl Drop for EmbeddedGenerationRequest {
    fn drop(&mut self) {
        self.system_prompt.zeroize();
        self.user_content.zeroize();
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddedModelLoadRequest {
    authorization_token: String,
    context_tokens: u32,
    cpu_threads: u32,
    #[serde(default)]
    allow_memory_overcommit: bool,
}

#[tauri::command]
pub(crate) async fn authorize_embedded_model(
    path: String,
    allow_memory_overcommit: Option<bool>,
    app: AppHandle,
    state: State<'_, EmbeddedAiState>,
) -> Result<EmbeddedModelInfo, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .request(
                &app,
                "authorize",
                json!({
                    "path": path,
                    "allowMemoryOvercommit": allow_memory_overcommit,
                }),
            )
            .and_then(|value| decode(value, "model information"))
    })
    .await
    .map_err(|_| HELPER_STOPPED.to_owned())?
}

#[tauri::command]
pub(crate) async fn load_embedded_model(
    request: EmbeddedModelLoadRequest,
    app: AppHandle,
    state: State<'_, EmbeddedAiState>,
) -> Result<EmbeddedModelStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .request(&app, "load", json!({ "request": request }))
            .and_then(|value| decode(value, "model status"))
    })
    .await
    .map_err(|_| HELPER_STOPPED.to_owned())?
}

#[tauri::command]
pub(crate) async fn unload_embedded_model(
    app: AppHandle,
    state: State<'_, EmbeddedAiState>,
) -> Result<EmbeddedModelStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .request(&app, "unload", json!({}))
            .and_then(|value| decode(value, "model status"))
    })
    .await
    .map_err(|_| HELPER_STOPPED.to_owned())?
}

#[tauri::command]
pub(crate) async fn embedded_model_status(
    app: AppHandle,
    state: State<'_, EmbeddedAiState>,
) -> Result<EmbeddedModelStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .request(&app, "status", json!({}))
            .and_then(|value| decode(value, "model status"))
    })
    .await
    .map_err(|_| HELPER_STOPPED.to_owned())?
}

#[tauri::command]
pub(crate) async fn cancel_embedded_generation(
    request_id: String,
    app: AppHandle,
    state: State<'_, EmbeddedAiState>,
) -> Result<bool, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .request(&app, "cancel", json!({ "requestId": request_id }))
            .and_then(|value| decode(value, "generation cancellation"))
    })
    .await
    .map_err(|_| HELPER_STOPPED.to_owned())?
}

#[tauri::command]
pub(crate) async fn generate_embedded_text(
    request: EmbeddedGenerationRequest,
    on_chunk: Channel<EmbeddedGenerationChunk>,
    app: AppHandle,
    state: State<'_, EmbeddedAiState>,
) -> Result<EmbeddedGenerationResult, String> {
    validate_generation_request(&request)?;
    let request_id = request.request_id.clone();
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .stream(
                &app,
                "generate",
                json!({ "request": request }),
                &request_id,
                on_chunk,
            )
            .and_then(|value| decode(value, "generation result"))
    })
    .await
    .map_err(|_| "The local inference worker stopped unexpectedly.".to_owned())?
}

fn validate_generation_request(request: &EmbeddedGenerationRequest) -> Result<(), String> {
    if request.model_id.is_empty() || request.model_id.len() > 128 {
        return Err("Select a valid local model before generating text.".to_owned());
    }
    if request.system_prompt.contains('\0') || request.user_content.contains('\0') {
        return Err("The local model prompt contains an unsupported null character.".to_owned());
    }
    let prompt_bytes = request
        .system_prompt
        .len()
        .checked_add(request.user_content.len())
        .ok_or_else(|| "The local prompt size exceeded the supported limit.".to_owned())?;
    if prompt_bytes > MAX_PROMPT_BYTES {
        return Err("The combined local model prompt exceeds the 4 MiB safety limit.".to_owned());
    }
    if !(1..=MAX_OUTPUT_TOKENS).contains(&request.maximum_output_tokens) {
        return Err("Local model output must be between 1 and 8,192 tokens.".to_owned());
    }
    Ok(())
}

fn decode<T: for<'de> Deserialize<'de>>(value: Value, label: &str) -> Result<T, String> {
    serde_json::from_value(value)
        .map_err(|_| format!("The local embedded AI helper returned an invalid {label}."))
}

impl EmbeddedAiState {
    fn request(&self, app: &AppHandle, action: &str, payload: Value) -> Result<Value, String> {
        let receiver = self.send(app, action, payload)?;
        loop {
            match receiver.recv() {
                Ok(SidecarMessage::Result(value)) => return Ok(value),
                Ok(SidecarMessage::Error(error)) => return Err(error),
                Ok(SidecarMessage::Chunk(_)) => {}
                Err(_) => return Err(HELPER_STOPPED.to_owned()),
            }
        }
    }

    fn stream(
        &self,
        app: &AppHandle,
        action: &str,
        payload: Value,
        request_id: &str,
        on_chunk: Channel<EmbeddedGenerationChunk>,
    ) -> Result<Value, String> {
        let receiver = self.send(app, action, payload)?;
        loop {
            match receiver.recv() {
                Ok(SidecarMessage::Chunk(text)) => {
                    if on_chunk.send(EmbeddedGenerationChunk { text }).is_err() {
                        let _ = self.request(app, "cancel", json!({ "requestId": request_id }));
                        return Err("The local generation stream was closed.".to_owned());
                    }
                }
                Ok(SidecarMessage::Result(value)) => return Ok(value),
                Ok(SidecarMessage::Error(error)) => return Err(error),
                Err(_) => return Err("The local inference worker stopped unexpectedly.".to_owned()),
            }
        }
    }

    fn send(
        &self,
        app: &AppHandle,
        action: &str,
        payload: Value,
    ) -> Result<Receiver<SidecarMessage>, String> {
        let mut process = self
            .process
            .lock()
            .map_err(|_| "The local embedded AI state is unavailable.".to_owned())?;
        if process.is_none() {
            *process = Some(Sidecar::start(app)?);
        }
        let sidecar = process
            .as_mut()
            .ok_or_else(|| "The local embedded AI helper is unavailable.".to_owned())?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        match sidecar.request(id, action, payload) {
            Ok(receiver) => Ok(receiver),
            Err(error) => {
                *process = None;
                Err(error)
            }
        }
    }
}

enum SidecarMessage {
    Chunk(String),
    Result(Value),
    Error(String),
}

#[derive(Default)]
struct PendingRequests {
    closed: bool,
    senders: HashMap<u64, Sender<SidecarMessage>>,
}

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    pending: Arc<Mutex<PendingRequests>>,
}

impl Sidecar {
    fn start(app: &AppHandle) -> Result<Self, String> {
        let executable = locate_sidecar(app)?;
        let mut command = Command::new(&executable);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|_| {
            "The bundled local AI helper could not be started. Repair or reinstall Tutorux to restore local GGUF inference.".to_owned()
        })?;
        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(
                    "The bundled local AI helper did not expose its request stream.".to_owned(),
                );
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(
                    "The bundled local AI helper did not expose its response stream.".to_owned(),
                );
            }
        };
        let pending = Arc::new(Mutex::new(PendingRequests::default()));
        let reader_pending = Arc::clone(&pending);
        if std::thread::Builder::new()
            .name("tutorux-embedded-ai-reader".to_owned())
            .spawn(move || read_responses(stdout, reader_pending))
            .is_err()
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "The bundled local AI helper response reader could not be started.".to_owned(),
            );
        }
        Ok(Self {
            child,
            stdin,
            pending,
        })
    }

    fn request(
        &mut self,
        id: u64,
        action: &str,
        payload: Value,
    ) -> Result<Receiver<SidecarMessage>, String> {
        let mut message = payload;
        let fields = message
            .as_object_mut()
            .ok_or_else(|| "The local embedded AI request is invalid.".to_owned())?;
        fields.insert("id".to_owned(), json!(id));
        fields.insert("action".to_owned(), json!(action));
        let mut line = serde_json::to_vec(&message)
            .map_err(|_| "The local embedded AI request could not be encoded.".to_owned())?;
        line.push(b'\n');

        let (sender, receiver) = mpsc::channel();
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "The local embedded AI state is unavailable.".to_owned())?;
        if pending.closed {
            return Err(HELPER_STOPPED.to_owned());
        }
        pending.senders.insert(id, sender);
        if self
            .stdin
            .write_all(&line)
            .and_then(|()| self.stdin.flush())
            .is_err()
        {
            pending.senders.remove(&id);
            return Err(HELPER_STOPPED.to_owned());
        }
        Ok(receiver)
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        fail_pending(&self.pending);
    }
}

fn read_responses(stdout: ChildStdout, pending: Arc<Mutex<PendingRequests>>) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = value.get("id").and_then(Value::as_u64) else {
            continue;
        };
        let sender = pending
            .lock()
            .ok()
            .and_then(|pending| pending.senders.get(&id).cloned());
        let Some(sender) = sender else {
            continue;
        };
        if value.get("event").and_then(Value::as_str) == Some("chunk") {
            let text = value
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let _ = sender.send(SidecarMessage::Chunk(text));
            continue;
        }
        if let Ok(mut pending) = pending.lock() {
            pending.senders.remove(&id);
        }
        let message = if value.get("ok").and_then(Value::as_bool) == Some(true) {
            SidecarMessage::Result(value.get("result").cloned().unwrap_or(Value::Null))
        } else {
            SidecarMessage::Error(
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        "The local embedded AI helper could not complete the request.".to_owned()
                    }),
            )
        };
        let _ = sender.send(message);
    }
    fail_pending(&pending);
}

fn fail_pending(pending: &Mutex<PendingRequests>) {
    if let Ok(mut pending) = pending.lock() {
        pending.closed = true;
        for (_, sender) in pending.senders.drain() {
            let _ = sender.send(SidecarMessage::Error(HELPER_STOPPED.to_owned()));
        }
    }
}

fn locate_sidecar(app: &AppHandle) -> Result<PathBuf, String> {
    let file_name = if cfg!(windows) {
        "tutorux-embedded-ai.exe"
    } else {
        "tutorux-embedded-ai"
    };
    let mut directories = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            directories.push(directory.to_path_buf());
        }
    }
    if let Ok(resource_directory) = app.path().resource_dir() {
        directories.push(resource_directory);
    }
    directories.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));

    for directory in &directories {
        let direct = directory.join(file_name);
        if direct.is_file() {
            return Ok(direct);
        }
    }
    for directory in directories {
        for candidate_directory in [directory.clone(), directory.join("binaries")] {
            let Ok(entries) = fs::read_dir(candidate_directory) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && is_sidecar_file(&path) {
                    return Ok(path);
                }
            }
        }
    }
    Err("The bundled local AI helper is missing. Repair or reinstall Tutorux to restore local GGUF inference.".to_owned())
}

fn is_sidecar_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let extension_ok = path.extension().is_none()
        || path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"));
    extension_ok
        && (name == "tutorux-embedded-ai"
            || name == "tutorux-embedded-ai.exe"
            || name.starts_with("tutorux-embedded-ai-"))
}
