mod headless;
mod inference;
mod model;

use llama_cpp_2::{llama_backend::LlamaBackend, model::LlamaModel};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{ipc::Channel, State};
use uuid::Uuid;
use zeroize::Zeroize;

use inference::{generate_blocking, validate_generation_request};
use model::{
    ensure_memory_fits, estimate_memory, file_identity, inspect_gguf, stable_model_id,
    status_from_runtime, validate_context_and_threads, validate_selected_path, AuthorizedModel,
    LoadedModel,
};

pub use headless::{generate_model_text, inspect_model_path, HeadlessModelInspection};
pub(crate) use model::{estimate_gguf_memory, read_gguf_metadata, GgufMetadata};

const MIN_MODEL_FILE_BYTES: u64 = 24;
const MAX_MODEL_FILE_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_ESTIMATED_MEMORY_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MODEL_MEMORY_OVERHEAD_BYTES: u64 = 256 * 1024 * 1024;
const ESTIMATED_CONTEXT_BYTES_PER_TOKEN: u64 = 1024 * 1024;
const MAX_PROMPT_BYTES: usize = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MIN_CONTEXT_TOKENS: u32 = 32;
const MAX_CONTEXT_TOKENS: u32 = 32_768;
const MAX_CPU_THREADS: u32 = 16;
const MAX_OUTPUT_TOKENS: u32 = 8_192;
const MAX_CONCURRENT_GENERATIONS: usize = 1;

#[derive(Default)]
pub(crate) struct EmbeddedAiState {
    authorized_models: Mutex<HashMap<String, AuthorizedModel>>,
    runtime: Arc<Mutex<Option<LoadedModel>>>,
    active_generations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Clone, Serialize)]
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

#[derive(Clone, Serialize)]
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

#[derive(Serialize)]
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

#[derive(Deserialize)]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddedModelLoadRequest {
    authorization_token: String,
    context_tokens: u32,
    cpu_threads: u32,
    #[serde(default)]
    allow_memory_overcommit: bool,
}

#[tauri::command]
pub(crate) fn authorize_embedded_model(
    path: String,
    allow_memory_overcommit: Option<bool>,
    state: State<'_, EmbeddedAiState>,
) -> Result<EmbeddedModelInfo, String> {
    let selected = validate_selected_path(Path::new(&path))?;
    let identity = file_identity(&selected)?;
    let (architecture, name, tensor_count) = inspect_gguf(&selected)?;
    let model_id = stable_model_id(&selected, &identity);
    let estimated_memory_bytes = estimate_memory(identity.size, 4096)?;
    ensure_memory_fits(
        estimated_memory_bytes,
        allow_memory_overcommit.unwrap_or(false),
    )?;
    let token = Uuid::new_v4().to_string();
    let info = EmbeddedModelInfo {
        authorization_token: token.clone(),
        model_id,
        name,
        architecture,
        file_size_bytes: identity.size,
        tensor_count,
        estimated_memory_bytes,
        context_tokens: 4096,
        maximum_context_tokens: MAX_CONTEXT_TOKENS,
        maximum_cpu_threads: MAX_CPU_THREADS,
    };

    let mut authorized = state
        .authorized_models
        .lock()
        .map_err(|_| "Local model authorization state is unavailable.".to_owned())?;
    authorized.clear();
    authorized.insert(
        token,
        AuthorizedModel {
            path: selected,
            identity,
            info: info.clone(),
        },
    );
    Ok(info)
}

#[tauri::command]
pub(crate) fn load_embedded_model(
    request: EmbeddedModelLoadRequest,
    state: State<'_, EmbeddedAiState>,
) -> Result<EmbeddedModelStatus, String> {
    validate_context_and_threads(request.context_tokens, request.cpu_threads)?;
    if !state
        .active_generations
        .lock()
        .map_err(|_| "Local generation state is unavailable.".to_owned())?
        .is_empty()
    {
        return Err(
            "Cancel or finish the current local generation before loading a model.".to_owned(),
        );
    }

    let selected = state
        .authorized_models
        .lock()
        .map_err(|_| "Local model authorization state is unavailable.".to_owned())?
        .remove(&request.authorization_token)
        .ok_or_else(|| "Select and inspect the GGUF file again before loading it.".to_owned())?;
    let actual_identity = file_identity(&selected.path)?;
    if actual_identity != selected.identity {
        return Err(
            "The selected model file changed after inspection. Select it again.".to_owned(),
        );
    }
    let memory_estimate_bytes = estimate_memory(actual_identity.size, request.context_tokens)?;
    ensure_memory_fits(memory_estimate_bytes, request.allow_memory_overcommit)?;
    let mut runtime = state.runtime.try_lock().map_err(|_| {
        "The local model runtime is busy. Wait for it to finish and try again.".to_owned()
    })?;

    // llama.cpp has one process-wide backend. Release the previous model and
    // its backend lease before creating the replacement backend.
    drop(runtime.take());
    let mut backend = LlamaBackend::init()
        .map_err(|_| "The in-process GGUF runtime could not initialize.".to_owned())?;
    backend.void_logs();
    let model = LlamaModel::load_from_file(&backend, &selected.path, &Default::default()).map_err(
        |_| "The GGUF header was valid, but the model weights could not be loaded.".to_owned(),
    )?;
    let model_name = model
        .meta_val_str("general.name")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| selected.info.name.clone());
    *runtime = Some(LoadedModel {
        model: Some(model),
        backend: Some(backend),
        model_id: selected.info.model_id,
        name: model_name,
        path: selected.path,
        identity: selected.identity,
        context_tokens: request.context_tokens,
        cpu_threads: request.cpu_threads,
        memory_estimate_bytes,
    });
    Ok(status_from_runtime(runtime.as_ref()))
}

#[tauri::command]
pub(crate) fn unload_embedded_model(
    state: State<'_, EmbeddedAiState>,
) -> Result<EmbeddedModelStatus, String> {
    if !state
        .active_generations
        .lock()
        .map_err(|_| "Local generation state is unavailable.".to_owned())?
        .is_empty()
    {
        return Err(
            "Cancel or finish the current local generation before unloading the model.".to_owned(),
        );
    }
    let mut runtime = state.runtime.try_lock().map_err(|_| {
        "The local model runtime is busy. Wait for it to finish and try again.".to_owned()
    })?;
    runtime.take();
    Ok(status_from_runtime(None))
}

#[tauri::command]
pub(crate) fn embedded_model_status(
    state: State<'_, EmbeddedAiState>,
) -> Result<EmbeddedModelStatus, String> {
    let runtime = state
        .runtime
        .lock()
        .map_err(|_| "The local model runtime is unavailable.".to_owned())?;
    Ok(status_from_runtime(runtime.as_ref()))
}

#[tauri::command]
pub(crate) fn cancel_embedded_generation(
    request_id: String,
    state: State<'_, EmbeddedAiState>,
) -> Result<bool, String> {
    let active = state
        .active_generations
        .lock()
        .map_err(|_| "Local generation state is unavailable.".to_owned())?;
    if let Some(cancelled) = active.get(&request_id) {
        cancelled.store(true, Ordering::Release);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub(crate) async fn generate_embedded_text(
    request: EmbeddedGenerationRequest,
    on_chunk: Channel<EmbeddedGenerationChunk>,
    state: State<'_, EmbeddedAiState>,
) -> Result<EmbeddedGenerationResult, String> {
    validate_generation_request(&request)?;
    let request_id = Uuid::parse_str(&request.request_id)
        .map_err(|_| "The local generation request ID is invalid.".to_owned())?
        .to_string();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut active = state
            .active_generations
            .lock()
            .map_err(|_| "Local generation state is unavailable.".to_owned())?;
        if active.len() >= MAX_CONCURRENT_GENERATIONS {
            return Err("Only one in-process model generation can run at a time.".to_owned());
        }
        if active.contains_key(&request_id) {
            return Err("The local generation request ID is already active.".to_owned());
        }
        active.insert(request_id.clone(), Arc::clone(&cancel_flag));
    }

    let runtime = Arc::clone(&state.runtime);
    let worker_cancel = Arc::clone(&cancel_flag);
    let worker_result = tauri::async_runtime::spawn_blocking(move || {
        generate_blocking(&runtime, request, worker_cancel, &on_chunk)
    })
    .await;
    if let Ok(mut active) = state.active_generations.lock() {
        active.remove(&request_id);
    }
    worker_result.map_err(|_| "The local inference worker stopped unexpectedly.".to_owned())?
}
