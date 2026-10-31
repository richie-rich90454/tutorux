//! Window-free GGUF inspection and generation for the Rust CLI.

use llama_cpp_2::{
    context::params::LlamaContextParams, llama_backend::LlamaBackend, llama_batch::LlamaBatch,
    model::LlamaModel, sampling::LlamaSampler,
};
use serde::Serialize;
use std::num::NonZeroU32;
use std::path::Path;
use zeroize::Zeroizing;

use super::inference::render_prompt;
use super::model::{
    ensure_memory_fits, estimate_memory, file_identity, inspect_gguf, stable_model_id,
    validate_selected_path,
};
use super::{
    ESTIMATED_CONTEXT_BYTES_PER_TOKEN, MAX_CONTEXT_TOKENS, MAX_CPU_THREADS, MAX_OUTPUT_BYTES,
    MAX_OUTPUT_TOKENS,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessModelInspection {
    pub path: String,
    pub model_id: String,
    pub name: String,
    pub architecture: String,
    pub file_size_bytes: u64,
    pub tensor_count: u64,
    pub estimated_memory_bytes: u64,
    pub context_tokens: u32,
    pub maximum_context_tokens: u32,
    pub maximum_cpu_threads: u32,
}

pub fn inspect_model_path(path: &str) -> Result<HeadlessModelInspection, String> {
    let selected = validate_selected_path(Path::new(path))?;
    let identity = file_identity(&selected)?;
    let (architecture, name, tensor_count) = inspect_gguf(&selected)?;
    let estimated_memory_bytes = estimate_memory(identity.size, 4096)?;
    Ok(HeadlessModelInspection {
        path: selected.to_string_lossy().into_owned(),
        model_id: stable_model_id(&selected, &identity),
        name,
        architecture,
        file_size_bytes: identity.size,
        tensor_count,
        estimated_memory_bytes,
        context_tokens: 4096,
        maximum_context_tokens: MAX_CONTEXT_TOKENS,
        maximum_cpu_threads: MAX_CPU_THREADS,
    })
}

/// Load one GGUF file, generate a bounded greedy completion, and stream decoded text.
pub fn generate_model_text(
    path: &str,
    system_prompt: &str,
    user_content: &str,
    maximum_output_tokens: u32,
    cpu_threads: u32,
    on_token: &mut dyn FnMut(&str) -> Result<(), String>,
) -> Result<(u32, usize), String> {
    if !(1..=MAX_OUTPUT_TOKENS).contains(&maximum_output_tokens) {
        return Err("Local model output must be between 1 and 8,192 tokens.".to_owned());
    }
    if !(1..=MAX_CPU_THREADS).contains(&cpu_threads) {
        return Err("CPU threads must be between 1 and 16.".to_owned());
    }
    let prompt_bytes = system_prompt
        .len()
        .checked_add(user_content.len())
        .ok_or_else(|| "The local prompt size exceeded the supported limit.".to_owned())?;
    if prompt_bytes > 4 * 1024 * 1024 {
        return Err("The combined local model prompt exceeds the 4 MiB safety limit.".to_owned());
    }
    let selected = validate_selected_path(Path::new(path))?;
    let identity = file_identity(&selected)?;
    let memory_estimate = estimate_memory(identity.size, 4096)?;
    ensure_memory_fits(memory_estimate, false)?;

    let mut backend = LlamaBackend::init()
        .map_err(|_| "The in-process GGUF runtime could not initialize.".to_owned())?;
    backend.void_logs();
    let model = LlamaModel::load_from_file(&backend, &selected, &Default::default()).map_err(
        |_| "The GGUF header was valid, but the model weights could not be loaded.".to_owned(),
    )?;
    let system_prompt = Zeroizing::new(system_prompt.to_owned());
    let user_content = Zeroizing::new(user_content.to_owned());
    let prompt = Zeroizing::new(render_prompt(&model, &system_prompt, &user_content)?);
    let tokens = model.vocab().tokenize(prompt.as_bytes(), true, false);
    if tokens.is_empty() || tokens.len() >= 4096 {
        return Err("The prompt does not fit in the configured local model context.".to_owned());
    }
    let output_limit = (maximum_output_tokens as usize).min(4096 - tokens.len());
    let context_params = LlamaContextParams::default()
        .with_n_ctx(Some(
            NonZeroU32::new(4096).ok_or_else(|| "The configured model context is invalid.".to_owned())?,
        ))
        .with_n_batch(4096)
        .with_n_threads(cpu_threads as i32)
        .with_n_threads_batch(cpu_threads as i32);
    let mut context = model.new_context(&backend, context_params).map_err(|_| {
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
    let mut generated_tokens = 0u32;
    let mut response_bytes = 0usize;
    for _ in 0..output_limit {
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
        if !decoded_piece.is_empty() {
            response_bytes += decoded_piece.len();
            on_token(&decoded_piece)?;
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
    if !trailing_text.is_empty() {
        response_bytes += trailing_text.len();
        on_token(&trailing_text)?;
    }
    if generated_tokens == 0 || response_bytes == 0 {
        return Err("The local model returned no text.".to_owned());
    }
    Ok((generated_tokens, response_bytes))
}

#[allow(dead_code)]
const _CONTEXT_ESTIMATE_BYTES: u64 = ESTIMATED_CONTEXT_BYTES_PER_TOKEN;
