use std::collections::BTreeMap;

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use hmac::{Hmac, Mac};
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::Sha256;
use zeroize::Zeroize;

use crate::core::error::{err, CoreError, Result};
use crate::core::format::{uuid_to_bytes, ArchiveRecord, RecordType, MAX_RECORD_PAYLOAD};

const PASSPHRASE_MAX_BYTES: usize = 4096;
const ENVELOPE_SALT_BYTES: usize = 16;
const ENVELOPE_NONCE_BYTES: usize = 24;
const DATA_KEY_BYTES: usize = 32;
const WRAPPED_KEY_BYTES: usize = DATA_KEY_BYTES + 16;
const RECORD_NONCE_BYTES: usize = 24;
const HMAC_BYTES: usize = 32;
const MINIMUM_OPS_LIMIT: u32 = 2;
const MAXIMUM_OPS_LIMIT: u32 = 3;
const MINIMUM_MEMORY_LIMIT: u32 = 64 * 1024 * 1024;
const MAXIMUM_MEMORY_LIMIT: u32 = 256 * 1024 * 1024;
const INTERACTIVE_OPS_LIMIT: u32 = 2;
const INTERACTIVE_MEMORY_LIMIT: u32 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEnvelope {
    pub salt: Vec<u8>,
    pub nonce: Vec<u8>,
    pub wrapped_key: Vec<u8>,
    pub ops_limit: u32,
    pub memory_limit: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct RecordEncryptionContext<'a> {
    pub archive_id: &'a str,
    pub record_type: u16,
    pub record_id: &'a str,
    pub revision: u64,
    pub previous_offset: u64,
    pub codec: u8,
}

#[derive(Clone)]
pub struct ArchiveDataKey {
    bytes: [u8; DATA_KEY_BYTES],
}

impl Drop for ArchiveDataKey {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

impl std::fmt::Debug for ArchiveDataKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ArchiveDataKey([redacted])")
    }
}

fn encode_passphrase(value: &str) -> Result<Vec<u8>> {
    let bytes = value.as_bytes().to_vec();
    if bytes.is_empty() || bytes.len() > PASSPHRASE_MAX_BYTES {
        return err(
            "crypto_input_invalid",
            "Passphrase must contain between 1 and 4096 UTF-8 bytes.",
        );
    }
    Ok(bytes)
}

fn validate_kdf_limits(ops_limit: u32, memory_limit: u32) -> Result<()> {
    if !(MINIMUM_OPS_LIMIT..=MAXIMUM_OPS_LIMIT).contains(&ops_limit)
        || !(MINIMUM_MEMORY_LIMIT..=MAXIMUM_MEMORY_LIMIT).contains(&memory_limit)
    {
        return err(
            "archive_encryption_parameters_invalid",
            "Archive encryption parameters are outside the supported safe range.",
        );
    }
    Ok(())
}

fn derive_key(passphrase: &[u8], salt: &[u8], ops_limit: u32, memory_limit: u32) -> Result<[u8; 32]> {
    let params = Params::new(
        memory_limit / 1024,
        ops_limit,
        1,
        Some(DATA_KEY_BYTES),
    )
    .map_err(|_| {
        CoreError::new(
            "archive_encryption_parameters_invalid",
            "Archive encryption parameters are outside the supported safe range.",
        )
    })?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut output = [0u8; DATA_KEY_BYTES];
    argon2
        .hash_password_into(passphrase, salt, &mut output)
        .map_err(|_| {
            CoreError::new(
                "crypto_memory_unavailable",
                "Unable to derive the archive key with the available memory.",
            )
        })?;
    Ok(output)
}

fn key_wrap_associated_data(archive_id: &str) -> Result<Vec<u8>> {
    let mut bytes = b"TUTORUX-ARCHIVE-KEY-V1".to_vec();
    bytes.extend_from_slice(&uuid_to_bytes(archive_id)?);
    Ok(bytes)
}

fn record_associated_data(context: &RecordEncryptionContext<'_>) -> Result<Vec<u8>> {
    if context.codec > 1 {
        return err("record_codec_invalid", "Record codec is outside the v1 range.");
    }
    let mut bytes = b"TUTORUX-RECORD-V1".to_vec();
    bytes.extend_from_slice(&uuid_to_bytes(context.archive_id)?);
    bytes.extend_from_slice(&context.record_type.to_le_bytes());
    bytes.extend_from_slice(&uuid_to_bytes(context.record_id)?);
    bytes.extend_from_slice(&context.revision.to_le_bytes());
    bytes.extend_from_slice(&context.previous_offset.to_le_bytes());
    if context.codec != 0 {
        bytes.push(context.codec);
    }
    Ok(bytes)
}

pub fn unwrap_data_key(
    passphrase: &str,
    envelope: &ArchiveEnvelope,
    archive_id: &str,
) -> Result<ArchiveDataKey> {
    if envelope.salt.len() != ENVELOPE_SALT_BYTES
        || envelope.nonce.len() != ENVELOPE_NONCE_BYTES
        || envelope.wrapped_key.len() != WRAPPED_KEY_BYTES
    {
        return err(
            "archive_encryption_metadata_invalid",
            "Archive encryption metadata contains an invalid key envelope value.",
        );
    }
    validate_kdf_limits(envelope.ops_limit, envelope.memory_limit)?;
    let associated_data = key_wrap_associated_data(archive_id)?;
    let password = encode_passphrase(passphrase)?;
    let derived = derive_key(
        &password,
        &envelope.salt,
        envelope.ops_limit,
        envelope.memory_limit,
    )?;
    let cipher = XChaCha20Poly1305::new((&derived).into());
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&envelope.nonce),
            Payload {
                msg: &envelope.wrapped_key,
                aad: &associated_data,
            },
        )
        .map_err(|_| {
            CoreError::new(
                "archive_passphrase_invalid",
                "Passphrase is incorrect or the key envelope is damaged.",
            )
        })?;
    if plaintext.len() != DATA_KEY_BYTES {
        return err(
            "archive_passphrase_invalid",
            "Passphrase is incorrect or the key envelope is damaged.",
        );
    }
    let mut bytes = [0u8; DATA_KEY_BYTES];
    bytes.copy_from_slice(&plaintext);
    Ok(ArchiveDataKey { bytes })
}

pub fn wrap_data_key(
    passphrase: &str,
    key: &ArchiveDataKey,
    archive_id: &str,
) -> Result<ArchiveEnvelope> {
    let password = encode_passphrase(passphrase)?;
    if password.len() < 12 {
        return err(
            "archive_passphrase_too_short",
            "Archive passphrases must contain at least 12 UTF-8 bytes.",
        );
    }
    let mut salt = vec![0u8; ENVELOPE_SALT_BYTES];
    let mut nonce = vec![0u8; ENVELOPE_NONCE_BYTES];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let derived = derive_key(
        &password,
        &salt,
        INTERACTIVE_OPS_LIMIT,
        INTERACTIVE_MEMORY_LIMIT,
    )?;
    let associated_data = key_wrap_associated_data(archive_id)?;
    let cipher = XChaCha20Poly1305::new((&derived).into());
    let wrapped_key = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &key.bytes,
                aad: &associated_data,
            },
        )
        .map_err(|_| CoreError::new("crypto_key_wrap_failed", "Unable to wrap the archive data key."))?;
    Ok(ArchiveEnvelope {
        salt,
        nonce,
        wrapped_key,
        ops_limit: INTERACTIVE_OPS_LIMIT,
        memory_limit: INTERACTIVE_MEMORY_LIMIT,
    })
}

impl ArchiveDataKey {
    pub fn create_random() -> Self {
        let mut bytes = [0u8; DATA_KEY_BYTES];
        OsRng.fill_bytes(&mut bytes);
        Self { bytes }
    }

    pub fn encrypt_record_payload(
        &self,
        plaintext: &[u8],
        context: &RecordEncryptionContext<'_>,
    ) -> Result<Vec<u8>> {
        if plaintext.len() as u64 > MAX_RECORD_PAYLOAD - (RECORD_NONCE_BYTES + 16) as u64 {
            return err(
                "record_payload_limit",
                "Encrypted record exceeds the v1 payload limit.",
            );
        }
        let mut nonce = [0u8; RECORD_NONCE_BYTES];
        OsRng.fill_bytes(&mut nonce);
        let associated_data = record_associated_data(context)?;
        let cipher = XChaCha20Poly1305::new((&self.bytes).into());
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &associated_data,
                },
            )
            .map_err(|_| {
                CoreError::new(
                    "archive_record_encryption_failed",
                    "Unable to encrypt the archive record.",
                )
            })?;
        let mut output = Vec::with_capacity(RECORD_NONCE_BYTES + ciphertext.len());
        output.extend_from_slice(&nonce);
        output.extend_from_slice(&ciphertext);
        Ok(output)
    }

    pub fn decrypt_record_payload(
        &self,
        ciphertext: &[u8],
        context: &RecordEncryptionContext<'_>,
    ) -> Result<Vec<u8>> {
        if ciphertext.len() as u64 > MAX_RECORD_PAYLOAD {
            return err(
                "record_payload_limit",
                "Encrypted record exceeds the v1 payload limit.",
            );
        }
        if ciphertext.len() < RECORD_NONCE_BYTES + 16 {
            return err(
                "archive_record_encrypted",
                "Encrypted record is truncated or the archive is locked.",
            );
        }
        let associated_data = record_associated_data(context)?;
        let cipher = XChaCha20Poly1305::new((&self.bytes).into());
        cipher
            .decrypt(
                XNonce::from_slice(&ciphertext[..RECORD_NONCE_BYTES]),
                Payload {
                    msg: &ciphertext[RECORD_NONCE_BYTES..],
                    aad: &associated_data,
                },
            )
            .map_err(|_| {
                CoreError::new(
                    "archive_record_authentication_failed",
                    "Encrypted record authentication failed; archive metadata may be damaged.",
                )
            })
    }

    pub fn authenticate_bytes(&self, label: &str, payload: &[u8]) -> Vec<u8> {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&self.bytes)
            .expect("HMAC accepts a 32-byte key");
        mac.update(label.as_bytes());
        mac.update(payload);
        mac.finalize().into_bytes().to_vec()
    }

    pub fn authentication_matches(&self, label: &str, payload: &[u8], authentication: &[u8]) -> bool {
        if authentication.len() != HMAC_BYTES {
            return false;
        }
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&self.bytes)
            .expect("HMAC accepts a 32-byte key");
        mac.update(label.as_bytes());
        mac.update(payload);
        mac.verify_slice(authentication).is_ok()
    }
}

fn decode_hex(value: &str, field: &str, expected_bytes: usize) -> Result<Vec<u8>> {
    if value.len() != expected_bytes * 2 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return err(
            "archive_encryption_metadata_invalid",
            &format!("Archive encryption metadata contains an invalid {field} value."),
        );
    }
    (0..expected_bytes)
        .map(|index| {
            u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).map_err(|_| {
                CoreError::new(
                    "archive_encryption_metadata_invalid",
                    format!("Archive encryption metadata contains an invalid {field} value."),
                )
            })
        })
        .collect()
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn parse_limit(record: &ArchiveRecord, name: &str) -> Result<u32> {
    let value = record.field(name).unwrap_or("");
    if value.len() > 20 || value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return err(
            "archive_encryption_metadata_invalid",
            &format!("Archive encryption metadata contains an invalid {name} value."),
        );
    }
    value.parse::<u32>().map_err(|_| {
        CoreError::new(
            "archive_encryption_parameters_invalid",
            "Archive encryption parameters are outside the supported safe range.",
        )
    })
}

pub fn envelope_from_record(record: &ArchiveRecord, archive_id: &str) -> Result<ArchiveEnvelope> {
    if record.record_type != RecordType::ENCRYPTION
        || !record.id.eq_ignore_ascii_case(archive_id)
        || record.field("encryption_version") != Some("1")
        || record.field("kdf") != Some("argon2id13")
        || record.field("aead") != Some("xchacha20-poly1305-ietf")
    {
        return err(
            "archive_encryption_metadata_invalid",
            "Archive encryption metadata version or algorithm is unsupported.",
        );
    }
    let envelope = ArchiveEnvelope {
        salt: decode_hex(record.field("salt").unwrap_or(""), "salt", ENVELOPE_SALT_BYTES)?,
        nonce: decode_hex(
            record.field("nonce").unwrap_or(""),
            "nonce",
            ENVELOPE_NONCE_BYTES,
        )?,
        wrapped_key: decode_hex(
            record.field("wrapped_key").unwrap_or(""),
            "wrapped_key",
            WRAPPED_KEY_BYTES,
        )?,
        ops_limit: parse_limit(record, "opslimit")?,
        memory_limit: parse_limit(record, "memlimit")?,
    };
    validate_kdf_limits(envelope.ops_limit, envelope.memory_limit)?;
    Ok(envelope)
}

pub fn envelope_to_record(envelope: &ArchiveEnvelope, archive_id: &str) -> Result<ArchiveRecord> {
    if envelope.salt.len() != ENVELOPE_SALT_BYTES
        || envelope.nonce.len() != ENVELOPE_NONCE_BYTES
        || envelope.wrapped_key.len() != WRAPPED_KEY_BYTES
    {
        return err(
            "archive_encryption_metadata_invalid",
            "Archive encryption metadata contains an invalid key envelope value.",
        );
    }
    uuid_to_bytes(archive_id)?;
    validate_kdf_limits(envelope.ops_limit, envelope.memory_limit)?;
    let mut fields = BTreeMap::new();
    fields.insert("encryption_version".to_owned(), "1".to_owned());
    fields.insert("kdf".to_owned(), "argon2id13".to_owned());
    fields.insert("aead".to_owned(), "xchacha20-poly1305-ietf".to_owned());
    fields.insert("salt".to_owned(), encode_hex(&envelope.salt));
    fields.insert("nonce".to_owned(), encode_hex(&envelope.nonce));
    fields.insert("wrapped_key".to_owned(), encode_hex(&envelope.wrapped_key));
    fields.insert("opslimit".to_owned(), envelope.ops_limit.to_string());
    fields.insert("memlimit".to_owned(), envelope.memory_limit.to_string());
    Ok(ArchiveRecord {
        record_type: RecordType::ENCRYPTION,
        id: archive_id.to_owned(),
        revision: 0,
        previous_offset: 0,
        fields,
        blob: Vec::new(),
    })
}

pub fn verify_manifest_authentication(
    record: ArchiveRecord,
    key: &ArchiveDataKey,
) -> Result<ArchiveRecord> {
    let authentication = record
        .fields
        .get("manifest_auth")
        .cloned()
        .unwrap_or_default();
    let mut unsigned = record.clone();
    unsigned.fields.remove("manifest_auth");
    let payload = crate::core::format::encode_record_payload(&unsigned)?;
    let expected = decode_hex(&authentication, "manifest_auth", HMAC_BYTES)?;
    if !key.authentication_matches("TUTORUX-MANIFEST-V1", &payload, &expected) {
        return err(
            "archive_manifest_authentication_failed",
            "Archive manifest authentication failed.",
        );
    }
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::format::uuid_from_bytes;

    #[test]
    fn key_wrap_round_trips() {
        let key = ArchiveDataKey::create_random();
        let archive_id = uuid_from_bytes(&[7u8; 16]).unwrap();
        let envelope = wrap_data_key("a sufficiently long phrase", &key, &archive_id).unwrap();
        let unwrapped = unwrap_data_key("a sufficiently long phrase", &envelope, &archive_id).unwrap();
        assert_eq!(key.bytes, unwrapped.bytes);
    }

    #[test]
    fn record_payload_round_trips() {
        let key = ArchiveDataKey::create_random();
        let archive_id = uuid_from_bytes(&[9u8; 16]).unwrap();
        let record_id = uuid_from_bytes(&[3u8; 16]).unwrap();
        let context = RecordEncryptionContext {
            archive_id: &archive_id,
            record_type: RecordType::STUDENT,
            record_id: &record_id,
            revision: 4,
            previous_offset: 88,
            codec: 1,
        };
        let encrypted = key.encrypt_record_payload(b"hello", &context).unwrap();
        assert_eq!(
            key.decrypt_record_payload(&encrypted, &context).unwrap(),
            b"hello"
        );
    }
}
