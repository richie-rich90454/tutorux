use llama_cpp_2::{
    context::params::LlamaContextParams, llama_batch::LlamaBatch, model::LlamaModel,
    sampling::LlamaSampler,
};
use std::{
    num::NonZeroU32,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::ipc::Channel;
use zeroize::{Zeroize, Zeroizing};

use super::{
    model::{file_identity, LoadedModel},
    EmbeddedGenerationChunk, EmbeddedGenerationRequest, EmbeddedGenerationResult, MAX_OUTPUT_BYTES,
    MAX_OUTPUT_TOKENS, MAX_PROMPT_BYTES,
};

pub(super) fn generate_blocking(
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

pub(super) fn render_prompt(
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

pub(super) fn validate_generation_request(
    request: &EmbeddedGenerationRequest,
) -> Result<(), String> {
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
