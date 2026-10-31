use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::core::error::{err, Result};

pub trait ByteSource: Send + Sync {
    fn size(&self) -> u64;
    fn read(&self, offset: u64, length: usize) -> Result<Vec<u8>>;
}

#[derive(Debug, Clone)]
pub struct MemorySource {
    bytes: Arc<Vec<u8>>,
}

impl MemorySource {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self {
            bytes: Arc::new(bytes),
        }
    }

    pub fn data(&self) -> &[u8] {
        &self.bytes
    }
}

impl ByteSource for MemorySource {
    fn size(&self) -> u64 {
        self.bytes.len() as u64
    }

    fn read(&self, offset: u64, length: usize) -> Result<Vec<u8>> {
        validate_range(offset, length, self.size())?;
        let start = offset as usize;
        Ok(self.bytes[start..start + length].to_vec())
    }
}

pub struct FileSource {
    file: Mutex<File>,
    size: u64,
}

impl FileSource {
    pub fn open(path: &Path) -> Result<Self> {
        let file = File::open(path).map_err(|error| {
            crate::core::error::CoreError::new(
                "archive_open_failed",
                format!("Could not open archive: {error}"),
            )
        })?;
        let size = file
            .metadata()
            .map_err(|error| {
                crate::core::error::CoreError::new(
                    "archive_open_failed",
                    format!("Could not inspect archive: {error}"),
                )
            })?
            .len();
        Ok(Self {
            file: Mutex::new(file),
            size,
        })
    }
}

impl ByteSource for FileSource {
    fn size(&self) -> u64 {
        self.size
    }

    fn read(&self, offset: u64, length: usize) -> Result<Vec<u8>> {
        validate_range(offset, length, self.size())?;
        let mut file = self.file.lock().map_err(|_| {
            crate::core::error::CoreError::new("archive_read_failed", "Archive file lock was lost.")
        })?;
        file.seek(SeekFrom::Start(offset)).map_err(|error| {
            crate::core::error::CoreError::new(
                "archive_read_failed",
                format!("Could not seek in archive: {error}"),
            )
        })?;
        let mut bytes = vec![0u8; length];
        file.read_exact(&mut bytes).map_err(|error| {
            crate::core::error::CoreError::new(
                "archive_read_failed",
                format!("Could not read archive: {error}"),
            )
        })?;
        Ok(bytes)
    }
}

pub struct CompositeSource {
    base: Arc<dyn ByteSource>,
    appended: Arc<dyn ByteSource>,
    size: u64,
}

impl CompositeSource {
    pub fn new(base: Arc<dyn ByteSource>, appended: Arc<dyn ByteSource>) -> Self {
        let size = base.size() + appended.size();
        Self {
            base,
            appended,
            size,
        }
    }
}

impl ByteSource for CompositeSource {
    fn size(&self) -> u64 {
        self.size
    }

    fn read(&self, offset: u64, length: usize) -> Result<Vec<u8>> {
        validate_range(offset, length, self.size)?;
        let end = offset + length as u64;
        if end <= self.base.size() {
            return self.base.read(offset, length);
        }
        if offset >= self.base.size() {
            return self.appended.read(offset - self.base.size(), length);
        }
        let base_length = (self.base.size() - offset) as usize;
        let appended_length = length - base_length;
        let mut output = self.base.read(offset, base_length)?;
        output.extend(self.appended.read(0, appended_length)?);
        Ok(output)
    }
}

pub fn validate_range(offset: u64, length: usize, size: u64) -> Result<()> {
    if offset > size || length as u64 > size - offset {
        return err(
            "archive_read_out_of_bounds",
            "Archive read is outside the source bounds.",
        );
    }
    Ok(())
}
