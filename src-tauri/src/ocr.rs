use std::sync::OnceLock;

use ocrs::{ImageSource, OcrEngine, OcrEngineParams};
use rten::Model;

const DETECTION_MODEL: &[u8] = include_bytes!("../resources/ocr/text-detection.onnx");
const RECOGNITION_MODEL: &[u8] = include_bytes!("../resources/ocr/text-recognition.onnx");
const MAX_EDGE: u32 = 3200;

fn engine() -> Result<&'static OcrEngine, String> {
    static ENGINE: OnceLock<OcrEngine> = OnceLock::new();
    if let Some(engine) = ENGINE.get() {
        return Ok(engine);
    }
    let detection = Model::load_static_slice(DETECTION_MODEL)
        .map_err(|error| format!("Could not load the OCR detection model: {error}"))?;
    let recognition = Model::load_static_slice(RECOGNITION_MODEL)
        .map_err(|error| format!("Could not load the OCR recognition model: {error}"))?;
    let created = OcrEngine::new(OcrEngineParams {
        detection_model: Some(detection),
        recognition_model: Some(recognition),
        ..Default::default()
    })
    .map_err(|error| format!("Could not start the OCR engine: {error}"))?;
    let _ = ENGINE.set(created);
    ENGINE
        .get()
        .ok_or_else(|| "The OCR engine is unavailable.".to_owned())
}

pub fn recognize_image(bytes: &[u8]) -> Result<String, String> {
    let image = image::load_from_memory(bytes)
        .map_err(|error| format!("The image could not be decoded for OCR: {error}"))?;
    let image = if image.width() > MAX_EDGE || image.height() > MAX_EDGE {
        image.thumbnail(MAX_EDGE, MAX_EDGE)
    } else {
        image
    };
    let rgb = image.into_rgb8();
    let source = ImageSource::from_bytes(rgb.as_raw(), rgb.dimensions())
        .map_err(|error| format!("The image could not be prepared for OCR: {error}"))?;
    let engine = engine()?;
    let input = engine
        .prepare_input(source)
        .map_err(|error| format!("The OCR input could not be prepared: {error}"))?;
    let text = engine
        .get_text(&input)
        .map_err(|error| format!("OCR could not read the image: {error}"))?;
    Ok(text.trim().to_owned())
}

#[cfg(test)]
mod tests {
    #[test]
    fn blank_images_are_valid_ocr_input() {
        let image = image::RgbImage::from_pixel(64, 64, image::Rgb([255, 255, 255]));
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        let text = super::recognize_image(&bytes).unwrap();
        assert!(text.is_empty() || text.chars().all(|character| character.is_whitespace()));
    }

    #[test]
    fn reads_printed_text() {
        let text =
            super::recognize_image(include_bytes!("../tests/fixtures/ocr-sample.png")).unwrap();
        assert!(
            text.to_uppercase().contains("FRACTION"),
            "OCR returned {text:?}"
        );
    }
}
