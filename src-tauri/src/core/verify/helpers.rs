pub(crate) fn is_known_type_name(name: &str) -> bool {
    if name == "UNKNOWN" || name == "INDEX" || name == "COMMIT" {
        return true;
    }
    (1..=14u16).any(|record_type| {
        crate::core::format::record_type_name(record_type).to_uppercase() == name
    })
}

pub(crate) fn single_colon_key(key: &str) -> Option<(&str, &str)> {
    let mut parts = key.split(':');
    let name = parts.next()?;
    let id = parts.next()?;
    if parts.next().is_some() || name.is_empty() || id.is_empty() {
        return None;
    }
    Some((name, id))
}

pub(crate) fn is_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

pub(crate) fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
