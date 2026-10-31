use llama_cpp_2::{gguf::GgufContext, llama_backend::LlamaBackend, model::LlamaModel};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    time::SystemTime,
};

use super::{
    EmbeddedModelInfo, EmbeddedModelStatus, ESTIMATED_CONTEXT_BYTES_PER_TOKEN, MAX_CONTEXT_TOKENS,
    MAX_CPU_THREADS, MAX_ESTIMATED_MEMORY_BYTES, MAX_MODEL_FILE_BYTES, MIN_CONTEXT_TOKENS,
    MIN_MODEL_FILE_BYTES, MODEL_MEMORY_OVERHEAD_BYTES,
};

pub(super) struct AuthorizedModel {
    pub(super) path: PathBuf,
    pub(super) identity: FileIdentity,
    pub(super) info: EmbeddedModelInfo,
}

pub(super) struct LoadedModel {
    // Drop the model before freeing the global llama backend.
    pub(super) model: Option<LlamaModel>,
    pub(super) backend: Option<LlamaBackend>,
    pub(super) model_id: String,
    pub(super) name: String,
    pub(super) path: PathBuf,
    pub(super) identity: FileIdentity,
    pub(super) context_tokens: u32,
    pub(super) cpu_threads: u32,
    pub(super) memory_estimate_bytes: u64,
}

impl Drop for LoadedModel {
    fn drop(&mut self) {
        drop(self.model.take());
        drop(self.backend.take());
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct FileIdentity {
    pub(super) size: u64,
    pub(super) modified_nanos: u128,
}

pub(super) fn validate_selected_path(path: &Path) -> Result<PathBuf, String> {
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

pub(super) fn inspect_gguf(path: &Path) -> Result<(String, String, u64), String> {
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

pub(super) fn file_identity(path: &Path) -> Result<FileIdentity, String> {
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

pub(super) fn stable_model_id(path: &Path, identity: &FileIdentity) -> String {
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

pub(super) fn validate_context_and_threads(
    context_tokens: u32,
    cpu_threads: u32,
) -> Result<(), String> {
    if !(MIN_CONTEXT_TOKENS..=MAX_CONTEXT_TOKENS).contains(&context_tokens) {
        return Err("Context length must be between 32 and 32,768 tokens.".to_owned());
    }
    if !(1..=MAX_CPU_THREADS).contains(&cpu_threads) {
        return Err("CPU threads must be between 1 and 16.".to_owned());
    }
    Ok(())
}

pub(super) fn estimate_memory(model_bytes: u64, context_tokens: u32) -> Result<u64, String> {
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

pub(super) fn ensure_memory_fits(
    estimate_bytes: u64,
    allow_memory_overcommit: bool,
) -> Result<(), String> {
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

pub(super) fn status_from_runtime(runtime: Option<&LoadedModel>) -> EmbeddedModelStatus {
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
