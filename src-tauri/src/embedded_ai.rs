use llama_cpp_2::{
    context::params::LlamaContextParams, gguf::GgufContext, llama_backend::LlamaBackend,
    llama_batch::LlamaBatch, model::LlamaModel, sampling::LlamaSampler,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::Read,
    num::NonZeroU32,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::SystemTime,
};
use tauri::{ipc::Channel, State};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

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

struct AuthorizedModel {
    path: PathBuf,
    identity: FileIdentity,
    info: EmbeddedModelInfo,
}

struct LoadedModel {
    // Drop the model before freeing the global llama backend.
    model: Option<LlamaModel>,
    backend: Option<LlamaBackend>,
    model_id: String,
    name: String,
    path: PathBuf,
    identity: FileIdentity,
    context_tokens: u32,
    cpu_threads: u32,
    memory_estimate_bytes: u64,
}

impl Drop for LoadedModel {
    fn drop(&mut self) {
        drop(self.model.take());
        drop(self.backend.take());
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileIdentity {
    size: u64,
    modified_nanos: u128,
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

fn generate_blocking(
    runtime: &Mutex<Option<LoadedModel>>,
    mut request: EmbeddedGenerationRequest,
    cancelled: Arc<AtomicBool>,
    on_chunk: &Channel<EmbeddedGenerationChunk>,
) -> Result<EmbeddedGenerationResult, String> {
    let mut system_prompt = Zeroizing::new(std::mem::take(&mut request.system_prompt));
    let mut user_content = Zeroizing::new(std::mem::take(&mut request.user_content));
    let result = (|| {
        let mut runtime = runtime
            .lock()
            .map_err(|_| "The local model runtime is unavailable.".to_owned())?;
        let loaded = runtime
            .as_mut()
            .ok_or_else(|| "Choose and load a GGUF model before generating locally.".to_owned())?;
        if loaded.model_id != request.model_id {
            return Err(
                "The loaded GGUF model does not match the reviewed AI settings.".to_owned(),
            );
        }
        if file_identity(&loaded.path)? != loaded.identity {
            return Err(
                "The loaded model file changed on disk. Unload it and select it again.".to_owned(),
            );
        }
        let prompt = Zeroizing::new(render_prompt(
            loaded
                .model
                .as_ref()
                .ok_or_else(|| "The local model is unavailable.".to_owned())?,
            &system_prompt,
            &user_content,
        )?);
        if prompt.len() > MAX_PROMPT_BYTES {
            return Err(
                "The combined local model prompt exceeds the 4 MiB safety limit.".to_owned(),
            );
        }
        if cancelled.load(Ordering::Acquire) {
            return Err("Local generation was cancelled.".to_owned());
        }

        let model = loaded
            .model
            .as_ref()
            .ok_or_else(|| "The local model is unavailable.".to_owned())?;
        let backend = loaded
            .backend
            .as_ref()
            .ok_or_else(|| "The local inference backend is unavailable.".to_owned())?;
        let tokens = model.vocab().tokenize(prompt.as_bytes(), true, false);
        if tokens.is_empty() || tokens.len() >= loaded.context_tokens as usize {
            return Err(
                "The prompt does not fit in the configured local model context.".to_owned(),
            );
        }
        let available_output_tokens = loaded.context_tokens as usize - tokens.len();
        let output_limit = (request.maximum_output_tokens as usize).min(available_output_tokens);
        if output_limit == 0 {
            return Err("No model context remains for generated output.".to_owned());
        }

        let context_params = LlamaContextParams::default()
            .with_n_ctx(Some(NonZeroU32::new(loaded.context_tokens).ok_or_else(
                || "The configured model context is invalid.".to_owned(),
            )?))
            .with_n_batch(loaded.context_tokens)
            .with_n_threads(loaded.cpu_threads as i32)
            .with_n_threads_batch(loaded.cpu_threads as i32);
        let mut context = model.new_context(backend, context_params).map_err(|_| {
            "The model context could not be allocated within the configured limits.".to_owned()
        })?;
        let mut batch = LlamaBatch::new(tokens.len(), 1);
        batch
            .add_sequence(&tokens, 0, false)
            .map_err(|_| "The prompt could not be queued for local evaluation.".to_owned())?;
        context
            .decode(&mut batch)
            .map_err(|_| "The local model could not evaluate the reviewed prompt.".to_owned())?;

        let mut sampler = LlamaSampler::chain_simple([LlamaSampler::greedy()]);
        let mut decoder = encoding_rs::UTF_8.new_decoder();
        let mut response_bytes = 0usize;
        let mut generated_tokens = 0u32;
        for _ in 0..output_limit {
            if cancelled.load(Ordering::Acquire) {
                return Err("Local generation was cancelled.".to_owned());
            }
            let token = sampler.sample(&context, batch.n_tokens() - 1);
            if model.vocab().is_eog(token) {
                break;
            }
            sampler.accept(token);
            let piece = model.vocab().token_to_piece(token, false, None);
            if piece.len() > MAX_OUTPUT_BYTES.saturating_sub(response_bytes) {
                return Err("Generated local text exceeded the 8 MiB output limit.".to_owned());
            }
            let mut decoded_piece = String::new();
            let (_, read, _) = decoder.decode_to_string(&piece, &mut decoded_piece, false);
            if read != piece.len() {
                return Err("The GGUF tokenizer returned incomplete output bytes.".to_owned());
            }
            if decoded_piece.len() > MAX_OUTPUT_BYTES.saturating_sub(response_bytes) {
                return Err("Generated local text exceeded the 8 MiB output limit.".to_owned());
            }
            if !decoded_piece.is_empty() {
                response_bytes += decoded_piece.len();
                on_chunk
                    .send(EmbeddedGenerationChunk {
                        text: decoded_piece,
                    })
                    .map_err(|_| {
                        cancelled.store(true, Ordering::Release);
                        "The local generation stream was closed.".to_owned()
                    })?;
            }
            generated_tokens = generated_tokens.saturating_add(1);
            if generated_tokens as usize >= output_limit {
                break;
            }
            batch.clear();
            batch
                .add(
                    token,
                    generated_tokens as i32 + tokens.len() as i32 - 1,
                    &[0],
                    true,
                )
                .map_err(|_| "A generated token could not be queued for evaluation.".to_owned())?;
            context
                .decode(&mut batch)
                .map_err(|_| "The local model could not evaluate its next token.".to_owned())?;
        }
        let mut trailing_text = String::new();
        let (_, _, _) = decoder.decode_to_string(&[], &mut trailing_text, true);
        if trailing_text.len() > MAX_OUTPUT_BYTES.saturating_sub(response_bytes) {
            return Err("Generated local text exceeded the 8 MiB output limit.".to_owned());
        }
        if !trailing_text.is_empty() {
            response_bytes += trailing_text.len();
            on_chunk
                .send(EmbeddedGenerationChunk {
                    text: trailing_text,
                })
                .map_err(|_| {
                    cancelled.store(true, Ordering::Release);
                    "The local generation stream was closed.".to_owned()
                })?;
        }
        if generated_tokens == 0 || response_bytes == 0 {
            return Err("The local model returned no text.".to_owned());
        }
        Ok(EmbeddedGenerationResult {
            generated_tokens,
            response_bytes,
        })
    })();
    system_prompt.zeroize();
    user_content.zeroize();
    request.system_prompt.zeroize();
    request.user_content.zeroize();
    result
}

fn render_prompt(
    model: &LlamaModel,
    system_prompt: &str,
    user_content: &str,
) -> Result<String, String> {
    let (system_role, user_role) = ("system", "user");
    let system =
        llama_cpp_2::model::LlamaChatMessage::new(system_role.to_owned(), system_prompt.to_owned())
            .map_err(|_| "The local system prompt contains unsupported data.".to_owned())?;
    let user =
        llama_cpp_2::model::LlamaChatMessage::new(user_role.to_owned(), user_content.to_owned())
            .map_err(|_| "The local user prompt contains unsupported data.".to_owned())?;
    let messages = [system, user];
    if let Ok(template) = model.chat_template(None) {
        if let Ok(prompt) = model.apply_chat_template(&template, &messages, true) {
            return Ok(prompt);
        }
    }
    Ok(format!(
        "System:\n{system_prompt}\n\nUser:\n{user_content}\n\nAssistant:\n"
    ))
}

fn validate_selected_path(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "The selected model file could not be read.".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Choose a regular GGUF model file, not a folder or symbolic link.".to_owned());
    }
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("gguf"))
    {
        return Err("Choose a file with the .gguf extension.".to_owned());
    }
    let selected = fs::canonicalize(path)
        .map_err(|_| "The selected model path could not be resolved.".to_owned())?;
    let size = fs::metadata(&selected)
        .map_err(|_| "The selected model file could not be inspected.".to_owned())?
        .len();
    if !(MIN_MODEL_FILE_BYTES..=MAX_MODEL_FILE_BYTES).contains(&size) {
        return Err("GGUF models must be at least 24 bytes and no larger than 64 GiB.".to_owned());
    }
    Ok(selected)
}

fn inspect_gguf(path: &Path) -> Result<(String, String, u64), String> {
    let mut header = [0u8; 8];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|_| "The selected file is too short to contain a GGUF header.".to_owned())?;
    let version = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    if &header[..4] != b"GGUF" || !(2..=3).contains(&version) {
        return Err("The selected file is not a supported GGUF v2 or v3 model.".to_owned());
    }
    let metadata = GgufContext::from_file(path)
        .ok_or_else(|| "The GGUF metadata or tensor index could not be validated.".to_owned())?;
    let architecture_index = metadata.find_key("general.architecture");
    let architecture = if architecture_index >= 0 {
        metadata
            .val_str(architecture_index)
            .unwrap_or_default()
            .to_owned()
    } else {
        String::new()
    };
    if architecture.is_empty() || metadata.n_tensors() <= 0 {
        return Err("The GGUF file is missing its model architecture or tensor index.".to_owned());
    }
    let name_index = metadata.find_key("general.name");
    let name = if name_index >= 0 {
        metadata
            .val_str(name_index)
            .unwrap_or_default()
            .trim()
            .chars()
            .take(160)
            .collect::<String>()
    } else {
        String::new()
    };
    let name = if name.is_empty() {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("GGUF model")
            .chars()
            .take(160)
            .collect()
    } else {
        name
    };
    Ok((architecture, name, metadata.n_tensors() as u64))
}

fn file_identity(path: &Path) -> Result<FileIdentity, String> {
    let link_metadata = fs::symlink_metadata(path)
        .map_err(|_| "The selected GGUF model file is no longer available.".to_owned())?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        return Err("The selected model path is no longer a regular file.".to_owned());
    }
    let metadata = fs::metadata(path)
        .map_err(|_| "The selected GGUF model file is no longer available.".to_owned())?;
    if !metadata.is_file()
        || !(MIN_MODEL_FILE_BYTES..=MAX_MODEL_FILE_BYTES).contains(&metadata.len())
    {
        return Err("The GGUF model file changed or exceeded the 64 GiB size limit.".to_owned());
    }
    let modified_nanos = metadata
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(FileIdentity {
        size: metadata.len(),
        modified_nanos,
    })
}

fn stable_model_id(path: &Path, identity: &FileIdentity) -> String {
    let mut digest = Sha256::new();
    digest.update(path.to_string_lossy().as_bytes());
    digest.update(identity.size.to_le_bytes());
    digest.update(identity.modified_nanos.to_le_bytes());
    let fingerprint = digest.finalize();
    let short = fingerprint[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("gguf:{short}")
}

fn validate_context_and_threads(context_tokens: u32, cpu_threads: u32) -> Result<(), String> {
    if !(MIN_CONTEXT_TOKENS..=MAX_CONTEXT_TOKENS).contains(&context_tokens) {
        return Err("Context length must be between 32 and 32,768 tokens.".to_owned());
    }
    if !(1..=MAX_CPU_THREADS).contains(&cpu_threads) {
        return Err("CPU threads must be between 1 and 16.".to_owned());
    }
    Ok(())
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

fn estimate_memory(model_bytes: u64, context_tokens: u32) -> Result<u64, String> {
    let context_bytes = u64::from(context_tokens)
        .checked_mul(ESTIMATED_CONTEXT_BYTES_PER_TOKEN)
        .ok_or_else(|| "The selected context would exceed the local memory ceiling.".to_owned())?;
    let estimate = model_bytes
        .checked_add(context_bytes)
        .and_then(|value| value.checked_add(MODEL_MEMORY_OVERHEAD_BYTES))
        .ok_or_else(|| "The selected model would exceed the local memory ceiling.".to_owned())?;
    if estimate > MAX_ESTIMATED_MEMORY_BYTES {
        return Err("The model and requested context exceed the 64 GiB memory estimate limit. Choose a smaller model or shorter context.".to_owned());
    }
    Ok(estimate)
}

fn ensure_memory_fits(estimate_bytes: u64, allow_memory_overcommit: bool) -> Result<(), String> {
    if allow_memory_overcommit {
        return Ok(());
    }
    let available_bytes = crate::diagnostics::available_system_memory_bytes().map_err(|reason| {
        format!(
            "The available system memory could not be checked before loading the local model: {reason}. Enable explicit memory overcommit to load the model anyway."
        )
    })?;
    ensure_memory_fits_with(estimate_bytes, available_bytes)
}

fn ensure_memory_fits_with(estimate_bytes: u64, available_bytes: u64) -> Result<(), String> {
    if estimate_bytes <= available_bytes {
        return Ok(());
    }
    Err(format!(
        "The model and requested context need about {:.1} GiB, but only {:.1} GiB of system memory is available. Choose a smaller model or shorter context, or explicitly allow memory overcommit.",
        estimate_bytes as f64 / 1_073_741_824.0,
        available_bytes as f64 / 1_073_741_824.0,
    ))
}

fn status_from_runtime(runtime: Option<&LoadedModel>) -> EmbeddedModelStatus {
    match runtime {
        Some(model) => EmbeddedModelStatus {
            loaded: true,
            model_id: Some(model.model_id.clone()),
            name: Some(model.name.clone()),
            path_name: model
                .path
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_owned),
            context_tokens: Some(model.context_tokens),
            cpu_threads: Some(model.cpu_threads),
            memory_estimate_bytes: Some(model.memory_estimate_bytes),
        },
        None => EmbeddedModelStatus {
            loaded: false,
            model_id: None,
            name: None,
            path_name: None,
            context_tokens: None,
            cpu_threads: None,
            memory_estimate_bytes: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_check_refuses_an_estimate_above_available_memory() {
        let error = ensure_memory_fits_with(8 * 1024 * 1024 * 1024, 4 * 1024 * 1024 * 1024)
            .expect_err("a model larger than available memory must be refused");
        assert!(error.contains("system memory"));
    }

    #[test]
    fn memory_check_accepts_a_fitting_estimate() {
        assert!(ensure_memory_fits_with(2 * 1024 * 1024 * 1024, 4 * 1024 * 1024 * 1024).is_ok());
    }

    #[test]
    fn memory_ceiling_still_rejects_an_oversized_estimate() {
        let error = estimate_memory(MAX_MODEL_FILE_BYTES, 32_768)
            .expect_err("the 64 GiB estimate ceiling must remain enforced");
        assert!(error.contains("64 GiB"));
    }
}
