use super::*;

fn parse_count(record: &ArchiveRecord, key: &str) -> Result<usize> {
    record
        .field(key)
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| {
            CoreError::new(
                "asset_manifest_invalid",
                "Material chunk manifest is inconsistent.",
            )
        })
}

fn manifest(
    snapshot: &ArchiveSnapshot,
    metadata: &ArchiveRecord,
) -> Result<(ArchiveRecord, bool, usize, Vec<String>, usize)> {
    if metadata.record_type != RecordType::ASSET_METADATA {
        return Err(CoreError::new(
            "asset_metadata_invalid",
            "Select a material.",
        ));
    }
    let blob_id = metadata.field("blob_id").unwrap_or("");
    let expected_hash = metadata.field("content_hash").unwrap_or("");
    let expected_size = parse_count(metadata, "byte_size")?;
    if !super::is_uuid(blob_id) || !is_sha256(expected_hash) {
        return Err(CoreError::new(
            "asset_metadata_invalid",
            "Material content metadata is invalid.",
        ));
    }
    let blob = snapshot
        .get_record(RecordType::ASSET_BLOB, blob_id)?
        .filter(|record| !record.deleted())
        .ok_or_else(|| {
            CoreError::new(
                "asset_blob_missing",
                "Material content is missing from this archive.",
            )
        })?;
    let is_manifest = blob.field("record_role") == Some("asset-blob-manifest");
    if is_manifest
        && blob.field("content_hash").map(str::to_lowercase) != Some(expected_hash.to_lowercase())
    {
        return Err(CoreError::new(
            "asset_manifest_hash_mismatch",
            "Material manifest hash does not match its metadata.",
        ));
    }
    let chunk_ids: Vec<String> = if is_manifest {
        blob.field("chunk_ids")
            .unwrap_or("")
            .split(',')
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .collect()
    } else {
        Vec::new()
    };
    let chunk_count = if is_manifest {
        parse_count(&blob, "chunk_count")?
    } else {
        1
    };
    let manifest_size = if is_manifest {
        parse_count(&blob, "byte_size")?
    } else {
        blob.blob.len()
    };
    if manifest_size != expected_size
        || (is_manifest
            && (chunk_count != chunk_ids.len()
                || chunk_count > 256 * 1024 * 1024 / ASSET_CHUNK_BYTES + 1))
    {
        return Err(CoreError::new(
            "asset_manifest_invalid",
            "Material chunk manifest is inconsistent.",
        ));
    }
    if let Some(expected) = metadata
        .field("blob_count")
        .filter(|value| !value.is_empty())
    {
        let expected = expected.parse::<usize>().map_err(|_| {
            CoreError::new(
                "asset_manifest_invalid",
                "Material chunk count does not match its metadata.",
            )
        })?;
        if expected != chunk_count {
            return Err(CoreError::new(
                "asset_manifest_invalid",
                "Material chunk count does not match its metadata.",
            ));
        }
    }
    Ok((blob, is_manifest, chunk_count, chunk_ids, expected_size))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn verify_asset(snapshot: &ArchiveSnapshot, metadata: &ArchiveRecord) -> Result<bool> {
    let (blob, is_manifest, chunk_count, chunk_ids, expected_size) = manifest(snapshot, metadata)?;
    let mut output = Vec::new();
    for index in 0..chunk_count {
        let bytes = if is_manifest {
            let chunk_id = chunk_ids.get(index).ok_or_else(|| {
                CoreError::new(
                    "asset_manifest_invalid",
                    "Material chunk manifest is inconsistent.",
                )
            })?;
            if !super::is_uuid(chunk_id) {
                return Err(CoreError::new(
                    "asset_chunk_id_invalid",
                    "Material chunk ID is invalid.",
                ));
            }
            let chunk = snapshot
                .get_record(RecordType::ASSET_BLOB, chunk_id)?
                .filter(|record| !record.deleted())
                .filter(|record| record.field("record_role") == Some("asset-blob-chunk"))
                .filter(|record| {
                    record.field("manifest_id").map(str::to_lowercase)
                        == Some(blob.id.to_lowercase())
                })
                .filter(|record| record.field("chunk_index") == Some(index.to_string().as_str()))
                .ok_or_else(|| {
                    CoreError::new("asset_chunk_missing", "A material chunk is missing.")
                })?;
            if parse_count(&chunk, "byte_size")? != chunk.blob.len() {
                return Err(CoreError::new(
                    "asset_manifest_invalid",
                    "Material chunk manifest is inconsistent.",
                ));
            }
            chunk.blob
        } else {
            blob.blob.clone()
        };
        output.extend_from_slice(&bytes);
    }
    if output.len() != expected_size {
        return Err(CoreError::new(
            "asset_manifest_invalid",
            "Material chunk manifest is inconsistent.",
        ));
    }
    let expected = metadata.field("content_hash").unwrap_or("").to_lowercase();
    Ok(sha256_hex(&output) == expected)
}

pub(crate) fn read_asset_bytes(
    snapshot: &ArchiveSnapshot,
    metadata: &ArchiveRecord,
) -> Result<Vec<u8>> {
    let verified = verify_asset(snapshot, metadata);
    match verified {
        Ok(true) => {}
        Ok(false) => return err_hash_mismatch(),
        Err(error) => return Err(error),
    }
    let (blob, is_manifest, chunk_count, chunk_ids, _) = manifest(snapshot, metadata)?;
    let mut output = Vec::new();
    for index in 0..chunk_count {
        if is_manifest {
            let chunk_id = chunk_ids.get(index).ok_or_else(|| {
                CoreError::new(
                    "asset_manifest_invalid",
                    "Material chunk manifest is inconsistent.",
                )
            })?;
            let chunk = snapshot
                .get_record(RecordType::ASSET_BLOB, chunk_id)?
                .ok_or_else(|| {
                    CoreError::new("asset_chunk_missing", "A material chunk is missing.")
                })?;
            output.extend_from_slice(&chunk.blob);
        } else {
            output.extend_from_slice(&blob.blob);
        }
    }
    Ok(output)
}

pub(crate) fn err_hash_mismatch() -> Result<Vec<u8>> {
    Err(CoreError::new(
        "asset_hash_mismatch",
        "Material content hash does not match its metadata.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::archive::create_archive_bytes;

    #[test]
    fn creation_starts_without_assets() {
        let bytes = create_archive_bytes("t", "d", 1).unwrap();
        let snapshot = ArchiveSnapshot::open_bytes(bytes).unwrap();
        let assets = snapshot
            .list_records(RecordType::ASSET_METADATA, false)
            .unwrap();
        assert!(assets.is_empty());
    }
}
