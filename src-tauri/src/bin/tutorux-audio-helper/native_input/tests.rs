use cpal::SampleFormat;

use super::device::output_sample_format;
use super::encode::encode_samples;

#[test]
fn native_formats_keep_their_sample_width() {
    assert_eq!(
        output_sample_format(SampleFormat::F32),
        Some(("pcm_f32le", 4))
    );
    assert_eq!(
        output_sample_format(SampleFormat::F64),
        Some(("pcm_f32le", 4))
    );
    assert_eq!(
        output_sample_format(SampleFormat::I16),
        Some(("pcm_s16le", 2))
    );
    assert_eq!(
        output_sample_format(SampleFormat::U16),
        Some(("pcm_s16le", 2))
    );
    assert_eq!(
        output_sample_format(SampleFormat::I24),
        Some(("pcm_s24le", 3))
    );
    assert_eq!(
        output_sample_format(SampleFormat::I32),
        Some(("pcm_s32le", 4))
    );
    assert_eq!(output_sample_format(SampleFormat::U8), Some(("pcm_u8", 1)));
    assert_eq!(output_sample_format(SampleFormat::DsdU8), None);
}

#[test]
fn interleaved_float_samples_are_not_downmixed() {
    let bytes = encode_samples(&[0.5_f32, -0.5_f32], "pcm_f32le");
    assert_eq!(
        bytes,
        [0.5_f32.to_le_bytes(), (-0.5_f32).to_le_bytes()].concat()
    );
}

#[test]
fn sixteen_bit_samples_keep_channel_order() {
    let bytes = encode_samples(&[i16::MAX, i16::MIN], "pcm_s16le");
    assert_eq!(
        bytes,
        [i16::MAX.to_le_bytes(), i16::MIN.to_le_bytes()].concat()
    );
}
