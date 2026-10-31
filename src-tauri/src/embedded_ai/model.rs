use llama_cpp_2::{llama_backend::LlamaBackend, model::LlamaModel};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
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

const GGUF_MAX_STRING_BYTES: u64 = 16 * 1024 * 1024;
const GGUF_MAX_METADATA_ENTRIES: u64 = 1_000_000;
const GGUF_MEMORY_OVERHEAD_BYTES: u128 = 256 * 1024 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct GgufMetadata {
    pub(crate) gguf_version: u32,
    pub(crate) tensor_count: u64,
    pub(crate) metadata_count: u64,
    pub(crate) architecture: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) training_context_tokens: String,
    pub(crate) embedding_length: String,
    pub(crate) layer_count: String,
}

/// Read GGUF header metadata without requiring tensor information. Tensor-only
/// runtimes still validate the tensor index when a model is actually loaded.
pub(crate) fn read_gguf_metadata(path: &Path) -> Result<GgufMetadata, String> {
    let file_size = fs::metadata(path)
        .map_err(|_| "The selected model file could not be inspected.".to_owned())?
        .len();
    if file_size < 24 {
        return Err("The GGUF header is truncated.".to_owned());
    }
    let file =
        File::open(path).map_err(|_| "The selected model file could not be read.".to_owned())?;
    let mut reader = GgufReader {
        file,
        position: 0,
        file_size,
    };
    let header = reader.bytes(24)?;
    if &header[..4] != b"GGUF" {
        return Err("The GGUF header is invalid.".to_owned());
    }
    let version = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    if !matches!(version, 2 | 3) {
        return Err("Unsupported GGUF version.".to_owned());
    }
    let tensor_count = u64::from_le_bytes(header[8..16].try_into().unwrap_or_default());
    let metadata_count = u64::from_le_bytes(header[16..24].try_into().unwrap_or_default());
    if metadata_count > GGUF_MAX_METADATA_ENTRIES {
        return Err("The GGUF metadata index is too large.".to_owned());
    }

    let mut strings: BTreeMap<String, String> = BTreeMap::new();
    let mut integers: BTreeMap<String, i128> = BTreeMap::new();
    for _ in 0..metadata_count {
        let key_length = reader.uint64()?;
        if key_length > GGUF_MAX_STRING_BYTES {
            return Err("A GGUF metadata key is too large.".to_owned());
        }
        let key = String::from_utf8_lossy(&reader.bytes(key_length)?).into_owned();
        let value_type = reader.uint32()?;
        if value_type == 8 {
            let value_length = reader.uint64()?;
            if value_length > GGUF_MAX_STRING_BYTES {
                return Err("A GGUF metadata string is too large.".to_owned());
            }
            if matches!(
                key.as_str(),
                "general.architecture" | "general.name" | "general.description"
            ) {
                let value = String::from_utf8_lossy(&reader.bytes(value_length)?).into_owned();
                strings.insert(key, value);
            } else {
                reader.skip(value_length)?;
            }
        } else if value_type == 9 {
            let element_type = reader.uint32()?;
            let count = reader.uint64()?;
            reader.skip_array(element_type, count)?;
        } else {
            if let Some(value) = reader.scalar(value_type)? {
                if key.ends_with(".context_length")
                    || key.ends_with(".embedding_length")
                    || key.ends_with(".block_count")
                {
                    integers.insert(key, value);
                }
            }
        }
    }

    let architecture = strings
        .get("general.architecture")
        .cloned()
        .unwrap_or_default();
    let unsigned = |key: String| {
        integers
            .get(&key)
            .filter(|value| **value >= 0)
            .map(i128::to_string)
            .unwrap_or_default()
    };
    Ok(GgufMetadata {
        gguf_version: version,
        tensor_count,
        metadata_count,
        training_context_tokens: unsigned(format!("{architecture}.context_length")),
        embedding_length: unsigned(format!("{architecture}.embedding_length")),
        layer_count: unsigned(format!("{architecture}.block_count")),
        name: strings.get("general.name").cloned().unwrap_or_default(),
        description: strings
            .get("general.description")
            .cloned()
            .unwrap_or_default(),
        architecture,
    })
}

pub(crate) fn estimate_gguf_memory(
    file_size: u64,
    embedding_length: &str,
    layer_count: &str,
    context_tokens: u64,
) -> Result<(String, bool), String> {
    let embedding = embedding_length.parse::<u128>().unwrap_or(0);
    let layers = layer_count.parse::<u128>().unwrap_or(0);
    if file_size == 0 || embedding == 0 || layers == 0 {
        return Err(
            "Memory estimation requires a GGUF inspection with dimensions and file size."
                .to_owned(),
        );
    }
    let context_bytes = u128::from(context_tokens)
        .checked_mul(embedding)
        .and_then(|value| value.checked_mul(layers))
        .and_then(|value| value.checked_mul(4))
        .unwrap_or(u128::MAX);
    let total = u128::from(file_size)
        .checked_add(context_bytes)
        .and_then(|value| value.checked_add(GGUF_MEMORY_OVERHEAD_BYTES))
        .unwrap_or(u128::MAX);
    if total > u128::from(u64::MAX) {
        return Ok((u64::MAX.to_string(), true));
    }
    Ok(((total as u64).to_string(), false))
}

struct GgufReader {
    file: File,
    position: u64,
    file_size: u64,
}

impl GgufReader {
    fn bytes(&mut self, length: u64) -> Result<Vec<u8>, String> {
        if self
            .position
            .checked_add(length)
            .is_none_or(|end| end > self.file_size)
        {
            return Err("The GGUF metadata is truncated.".to_owned());
        }
        let length = usize::try_from(length)
            .map_err(|_| "The GGUF metadata length is invalid.".to_owned())?;
        let mut buffer = vec![0u8; length];
        self.file
            .read_exact(&mut buffer)
            .map_err(|_| "The GGUF metadata is truncated.".to_owned())?;
        self.position += length as u64;
        Ok(buffer)
    }

    fn skip(&mut self, length: u64) -> Result<(), String> {
        if self
            .position
            .checked_add(length)
            .is_none_or(|end| end > self.file_size)
        {
            return Err("The GGUF metadata is truncated.".to_owned());
        }
        self.position += length;
        self.file
            .seek(SeekFrom::Start(self.position))
            .map_err(|_| "The GGUF metadata is truncated.".to_owned())?;
        Ok(())
    }

    fn uint32(&mut self) -> Result<u32, String> {
        let bytes = self.bytes(4)?;
        Ok(u32::from_le_bytes(bytes.try_into().unwrap_or_default()))
    }

    fn uint64(&mut self) -> Result<u64, String> {
        let bytes = self.bytes(8)?;
        Ok(u64::from_le_bytes(bytes.try_into().unwrap_or_default()))
    }

    fn scalar(&mut self, value_type: u32) -> Result<Option<i128>, String> {
        let bytes = self.bytes(u64::from(scalar_size(value_type)?))?;
        let value = match value_type {
            0 => i128::from(bytes[0]),
            1 => i128::from(i8::from_le_bytes([bytes[0]])),
            2 => i128::from(u16::from_le_bytes(bytes.try_into().unwrap_or_default())),
            3 => i128::from(i16::from_le_bytes(bytes.try_into().unwrap_or_default())),
            4 => i128::from(u32::from_le_bytes(bytes.try_into().unwrap_or_default())),
            5 => i128::from(i32::from_le_bytes(bytes.try_into().unwrap_or_default())),
            7 => i128::from(bytes[0] != 0),
            10 => i128::from(u64::from_le_bytes(bytes.try_into().unwrap_or_default())),
            11 => i128::from(i64::from_le_bytes(bytes.try_into().unwrap_or_default())),
            6 | 12 => return Ok(None),
            _ => return Err("The GGUF metadata contains an unsupported value type.".to_owned()),
        };
        Ok(Some(value))
    }

    fn skip_array(&mut self, element_type: u32, count: u64) -> Result<(), String> {
        if count > GGUF_MAX_METADATA_ENTRIES {
            return Err("The GGUF metadata array is too large.".to_owned());
        }
        if element_type == 8 {
            for _ in 0..count {
                let length = self.uint64()?;
                if length > GGUF_MAX_STRING_BYTES {
                    return Err("A GGUF metadata string is too large.".to_owned());
                }
                self.skip(length)?;
            }
            return Ok(());
        }
        if element_type == 9 {
            return Err("The GGUF metadata contains a nested array.".to_owned());
        }
        let total = u64::from(scalar_size(element_type)?)
            .checked_mul(count)
            .ok_or_else(|| "The GGUF metadata array is too large.".to_owned())?;
        if total > self.file_size {
            return Err("The GGUF metadata array is too large.".to_owned());
        }
        self.skip(total)
    }
}

fn scalar_size(value_type: u32) -> Result<u32, String> {
    match value_type {
        0 | 1 | 7 => Ok(1),
        2 | 3 => Ok(2),
        4 | 5 | 6 => Ok(4),
        10 | 11 | 12 => Ok(8),
        _ => Err("The GGUF metadata contains an unsupported value type.".to_owned()),
    }
}

pub(super) fn inspect_gguf(path: &Path) -> Result<(String, String, u64), String> {
    let metadata = read_gguf_metadata(path)?;
    let name = if metadata.name.trim().is_empty() {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("GGUF model")
            .chars()
            .take(160)
            .collect()
    } else {
        metadata.name.trim().chars().take(160).collect()
    };
    Ok((metadata.architecture, name, metadata.tensor_count))
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

    #[test]
    fn metadata_only_gguf_is_readable() {
        let mut bytes = b"GGUF".to_vec();
        bytes.extend(3u32.to_le_bytes());
        bytes.extend(0u64.to_le_bytes());
        bytes.extend(2u64.to_le_bytes());
        bytes.extend((b"general.architecture".len() as u64).to_le_bytes());
        bytes.extend(b"general.architecture");
        bytes.extend(8u32.to_le_bytes());
        bytes.extend(5u64.to_le_bytes());
        bytes.extend(b"llama");
        bytes.extend((b"llama.block_count".len() as u64).to_le_bytes());
        bytes.extend(b"llama.block_count");
        bytes.extend(4u32.to_le_bytes());
        bytes.extend(32u32.to_le_bytes());
        let path = std::env::temp_dir().join(format!("tutorux-gguf-{}.gguf", std::process::id()));
        std::fs::write(&path, &bytes).expect("write fixture");
        let metadata = read_gguf_metadata(&path).expect("metadata-only GGUF is valid");
        std::fs::remove_file(&path).ok();
        assert_eq!(metadata.tensor_count, 0);
        assert_eq!(metadata.architecture, "llama");
        assert_eq!(metadata.layer_count, "32");
    }
}
