use super::super::*;
use std::io::{Read, Write};

pub(super) struct PdfImage {
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) color_space: &'static str,
    pub(super) filter: &'static str,
    pub(super) bytes: Vec<u8>,
    pub(super) alpha: Option<Vec<u8>>,
}

fn image_error(message: &str) -> CliError {
    CliError(message.to_owned())
}

fn read_be_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let chunk = bytes.get(offset..offset + 4)?;
    Some(u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
}

fn inflate_zlib(data: &[u8], limit: usize) -> CliResult<Vec<u8>> {
    let mut decoder = flate2::read::ZlibDecoder::new(data);
    let mut output = Vec::new();
    decoder
        .by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut output)
        .map_err(|_| image_error("The PNG image data could not be decoded."))?;
    if output.len() > limit {
        return Err(image_error("The PNG image data exceeds its declared size.").into());
    }
    Ok(output)
}

fn deflate_zlib(data: &[u8]) -> CliResult<Vec<u8>> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(data)
        .map_err(|_| image_error("The PDF image stream could not be compressed."))?;
    encoder
        .finish()
        .map_err(|_| image_error("The PDF image stream could not be compressed.").into())
}

fn paeth(left: u8, above: u8, corner: u8) -> u8 {
    let estimate = left as i32 + above as i32 - corner as i32;
    let left_distance = (estimate - left as i32).abs();
    let above_distance = (estimate - above as i32).abs();
    let corner_distance = (estimate - corner as i32).abs();
    if left_distance <= above_distance && left_distance <= corner_distance {
        left
    } else if above_distance <= corner_distance {
        above
    } else {
        corner
    }
}

fn unfilter(raw: &[u8], height: usize, row_bytes: usize, bpp: usize) -> CliResult<Vec<u8>> {
    let stride = row_bytes + 1;
    let mut pixels = vec![0u8; height * row_bytes];
    for row in 0..height {
        let filter = raw[row * stride];
        let source = &raw[row * stride + 1..(row + 1) * stride];
        let target_start = row * row_bytes;
        for column in 0..row_bytes {
            let left = if column >= bpp {
                pixels[target_start + column - bpp]
            } else {
                0
            };
            let above = if row > 0 {
                pixels[target_start - row_bytes + column]
            } else {
                0
            };
            let corner = if row > 0 && column >= bpp {
                pixels[target_start - row_bytes + column - bpp]
            } else {
                0
            };
            let predictor = match filter {
                0 => 0,
                1 => left,
                2 => above,
                3 => ((left as u16 + above as u16) / 2) as u8,
                4 => paeth(left, above, corner),
                _ => return Err(image_error("The PNG row filter is unsupported.").into()),
            };
            pixels[target_start + column] = source[column].wrapping_add(predictor);
        }
    }
    Ok(pixels)
}

struct Png {
    width: u32,
    height: u32,
    color_type: u8,
    palette: Vec<[u8; 3]>,
    data: Vec<u8>,
}

fn parse_png(bytes: &[u8]) -> CliResult<Png> {
    if !bytes.starts_with(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']) {
        return Err(image_error("The PNG signature is invalid.").into());
    }
    let mut offset = 8usize;
    let mut width = 0u32;
    let mut height = 0u32;
    let mut color_type = 0u8;
    let mut palette = Vec::new();
    let mut data = Vec::new();
    let mut saw_header = false;
    while offset + 12 <= bytes.len() {
        let length = read_be_u32(bytes, offset)
            .ok_or_else(|| image_error("The PNG chunk is invalid."))? as usize;
        let kind = bytes
            .get(offset + 4..offset + 8)
            .ok_or_else(|| image_error("The PNG chunk is invalid."))?;
        let start = offset + 8;
        let end = start
            .checked_add(length)
            .filter(|end| end + 4 <= bytes.len())
            .ok_or_else(|| image_error("The PNG chunk exceeds its bounds."))?;
        let chunk = &bytes[start..end];
        if kind == b"IHDR".as_slice() {
            if chunk.len() < 13 {
                return Err(image_error("The PNG header is truncated.").into());
            }
            width = read_be_u32(chunk, 0).unwrap_or(0);
            height = read_be_u32(chunk, 4).unwrap_or(0);
            let bit_depth = chunk[8];
            color_type = chunk[9];
            if width == 0
                || height == 0
                || bit_depth != 8
                || chunk[10] != 0
                || chunk[11] != 0
                || chunk[12] != 0
            {
                return Err(image_error(
                    "Only 8-bit, non-interlaced PNG images are supported in PDF exports.",
                )
                .into());
            }
            if !matches!(color_type, 0 | 2 | 3 | 4 | 6) {
                return Err(image_error("The PNG color format is unsupported.").into());
            }
            saw_header = true;
        } else if kind == b"PLTE".as_slice() {
            palette = chunk
                .chunks_exact(3)
                .map(|entry| [entry[0], entry[1], entry[2]])
                .collect();
        } else if kind == b"IDAT".as_slice() {
            data.extend_from_slice(chunk);
        } else if kind == b"IEND".as_slice() {
            break;
        }
        offset = end + 4;
    }
    if !saw_header || data.is_empty() {
        return Err(image_error("The PNG image data is missing.").into());
    }
    Ok(Png {
        width,
        height,
        color_type,
        palette,
        data,
    })
}

fn png_image(bytes: &[u8]) -> CliResult<PdfImage> {
    let png = parse_png(bytes)?;
    let channels = match png.color_type {
        0 => 1usize,
        2 => 3,
        3 => 1,
        4 => 2,
        _ => 4,
    };
    let row_bytes = (png.width as usize)
        .checked_mul(channels)
        .filter(|value| *value <= 64 * 1024 * 1024)
        .ok_or_else(|| image_error("The PNG image is too large."))?;
    let expected = (png.height as usize)
        .checked_mul(row_bytes + 1)
        .filter(|value| *value <= 128 * 1024 * 1024)
        .ok_or_else(|| image_error("The PNG image is too large."))?;
    let raw = inflate_zlib(&png.data, expected)?;
    if raw.len() != expected {
        return Err(image_error("The PNG image data is incomplete.").into());
    }
    let pixels = unfilter(&raw, png.height as usize, row_bytes, channels)?;
    let (color_space, base, alpha) = match png.color_type {
        0 => ("/DeviceGray", pixels, None),
        2 => ("/DeviceRGB", pixels, None),
        3 => {
            if png.palette.is_empty() {
                return Err(image_error("The PNG palette is missing.").into());
            }
            let mut rgb = Vec::with_capacity(pixels.len() * 3);
            for index in pixels {
                let entry = png
                    .palette
                    .get(index as usize)
                    .ok_or_else(|| image_error("The PNG palette index is invalid."))?;
                rgb.extend_from_slice(entry);
            }
            ("/DeviceRGB", rgb, None)
        }
        4 => {
            let mut gray = Vec::with_capacity(pixels.len() / 2);
            let mut mask = Vec::with_capacity(pixels.len() / 2);
            for pair in pixels.chunks_exact(2) {
                gray.push(pair[0]);
                mask.push(pair[1]);
            }
            ("/DeviceGray", gray, Some(mask))
        }
        _ => {
            let mut rgb = Vec::with_capacity(pixels.len() / 4 * 3);
            let mut mask = Vec::with_capacity(pixels.len() / 4);
            for pixel in pixels.chunks_exact(4) {
                rgb.extend_from_slice(&pixel[..3]);
                mask.push(pixel[3]);
            }
            ("/DeviceRGB", rgb, Some(mask))
        }
    };
    Ok(PdfImage {
        width: png.width,
        height: png.height,
        color_space,
        filter: "/FlateDecode",
        bytes: deflate_zlib(&base)?,
        alpha: match alpha {
            Some(mask) => Some(deflate_zlib(&mask)?),
            None => None,
        },
    })
}

fn jpeg_components(bytes: &[u8]) -> Option<u8> {
    let mut offset = 2usize;
    while offset + 4 <= bytes.len() {
        if bytes[offset] != 0xff {
            offset += 1;
            continue;
        }
        while bytes.get(offset) == Some(&0xff) {
            offset += 1;
        }
        let marker = *bytes.get(offset)?;
        offset += 1;
        if marker == 0xd8 || marker == 0xd9 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let length = ((*bytes.get(offset)? as usize) << 8) | *bytes.get(offset + 1)? as usize;
        if length < 2 || length > bytes.len() - offset {
            break;
        }
        if matches!(
            marker,
            0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf
        ) {
            return bytes.get(offset + 7).copied();
        }
        offset += length;
    }
    None
}

pub(super) fn encode_image(mime_type: &str, bytes: &[u8]) -> CliResult<Option<PdfImage>> {
    match mime_type {
        "image/jpeg" | "image/jpg" => {
            let (width, height) = super::super::guide_docx::image_dimensions(mime_type, bytes)?;
            Ok(Some(PdfImage {
                width,
                height,
                color_space: if jpeg_components(bytes) == Some(1) {
                    "/DeviceGray"
                } else {
                    "/DeviceRGB"
                },
                filter: "/DCTDecode",
                bytes: bytes.to_vec(),
                alpha: None,
            }))
        }
        "image/png" => Ok(Some(png_image(bytes)?)),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for byte in bytes {
            crc ^= *byte as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn chunk(kind: &[u8], data: &[u8]) -> Vec<u8> {
        let mut output = (data.len() as u32).to_be_bytes().to_vec();
        output.extend_from_slice(kind);
        output.extend_from_slice(data);
        let mut crc_input = kind.to_vec();
        crc_input.extend_from_slice(data);
        output.extend_from_slice(&crc32(&crc_input).to_be_bytes());
        output
    }

    pub(super) fn png_rgba(width: u32, height: u32) -> Vec<u8> {
        let mut raw = Vec::new();
        for row in 0..height {
            raw.push(0);
            for column in 0..width {
                raw.extend_from_slice(&[(column * 60) as u8, (row * 90) as u8, 0x40, 0xff]);
            }
        }
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&raw).ok().unwrap();
        let compressed = encoder.finish().ok().unwrap();
        let mut header = width.to_be_bytes().to_vec();
        header.extend_from_slice(&height.to_be_bytes());
        header.extend_from_slice(&[8, 6, 0, 0, 0]);
        let mut output = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
        output.extend_from_slice(&chunk(b"IHDR", &header));
        output.extend_from_slice(&chunk(b"IDAT", &compressed));
        output.extend_from_slice(&chunk(b"IEND", &[]));
        output
    }

    #[test]
    fn decodes_png_pixels_and_alpha() {
        let bytes = png_rgba(3, 2);
        let image = encode_image("image/png", &bytes).ok().flatten().unwrap();
        assert_eq!(image.width, 3);
        assert_eq!(image.height, 2);
        assert_eq!(image.color_space, "/DeviceRGB");
        assert_eq!(image.filter, "/FlateDecode");
        assert!(image.alpha.is_some());
        let decoded = inflate_zlib(&image.bytes, 1024).ok().unwrap();
        assert_eq!(decoded.len(), 3 * 2 * 3);
    }

    #[test]
    fn rejects_interlaced_png() {
        let mut bytes = png_rgba(2, 2);
        let header = bytes
            .windows(4)
            .position(|window| window == b"IHDR")
            .unwrap();
        bytes[header + 16] = 1;
        assert!(encode_image("image/png", &bytes).is_err());
    }
}
