use super::*;

#[test]
fn crc_matches_reference_vector() {
    assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
}

#[test]
fn header_round_trips() {
    let header = ArchiveHeader {
        id: "01234567-89ab-cdef-0123-456789abcdef".to_owned(),
        major_version: 1,
        minor_version: 0,
        created_at_us: 42,
        capabilities: 0,
    };
    let bytes = encode_archive_header(&header);
    assert_eq!(decode_archive_header(&bytes).unwrap(), header);
}

#[test]
fn lz4_round_trips() {
    let payload = b"the quick brown fox jumps over the lazy dog ".repeat(40);
    let (codec, compressed) = compress_record_payload(&payload).unwrap();
    if codec == 1 {
        assert_eq!(decode_lz4_block(&compressed).unwrap(), payload);
    }
}
