use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

pub const CHUNK_SIZE: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct StoredBlob {
    pub hash: String,
    pub codec: i64,
    pub original_size: i64,
    pub stored_size: i64,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn compress(bytes: &[u8]) -> (i64, Vec<u8>) {
    if bytes.len() < 512 {
        return (0, bytes.to_vec());
    }
    match zstd::bulk::compress(bytes, 3) {
        Ok(compressed) if compressed.len() + 64 < bytes.len() => (1, compressed),
        _ => (0, bytes.to_vec()),
    }
}

fn decompress(codec: i64, stored: Vec<u8>, original_size: usize) -> Result<Vec<u8>, String> {
    match codec {
        0 => Ok(stored),
        1 => zstd::bulk::decompress(&stored, original_size)
            .map_err(|error| format!("Could not decompress workspace data: {error}")),
        other => Err(format!("Unknown workspace compression codec {other}.")),
    }
}

pub fn put_blob(conn: &Connection, bytes: &[u8]) -> Result<StoredBlob, String> {
    let hash = sha256_hex(bytes);
    let (codec, stored) = compress(bytes);
    conn.execute(
        "INSERT OR IGNORE INTO blobs (hash, codec, original_size, stored_size, data) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![hash, codec, bytes.len() as i64, stored.len() as i64, stored],
    )
    .map_err(|error| format!("Could not store workspace data: {error}"))?;
    Ok(StoredBlob {
        hash,
        codec,
        original_size: bytes.len() as i64,
        stored_size: stored.len() as i64,
    })
}

pub fn get_blob(conn: &Connection, hash: &str) -> Result<Vec<u8>, String> {
    let (codec, original_size, stored): (i64, i64, Vec<u8>) = conn
        .query_row(
            "SELECT codec, original_size, data FROM blobs WHERE hash = ?1",
            params![hash],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("Could not read workspace data: {error}"))?;
    decompress(codec, stored, original_size as usize)
}

pub fn put_recording_chunk(conn: &Connection, bytes: &[u8]) -> Result<StoredBlob, String> {
    put_blob(conn, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compresses_and_reads_round_trip() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE blobs (hash TEXT PRIMARY KEY, codec INTEGER, original_size INTEGER, stored_size INTEGER, data BLOB);")
            .unwrap();
        let data = b"tutorux ".repeat(4096);
        let stored = put_blob(&connection, &data).unwrap();
        assert_eq!(stored.codec, 1);
        assert_eq!(get_blob(&connection, &stored.hash).unwrap(), data);
    }
}
