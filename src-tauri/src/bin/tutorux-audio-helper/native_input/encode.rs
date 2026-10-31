use cpal::{
    Data, Sample, SampleFormat, SizedSample,
};

use super::device::CaptureFormat;

pub(super) fn encode_capture(data: &Data, format: &CaptureFormat) -> Result<Vec<u8>, String> {
    let pcm = match data.sample_format() {
        SampleFormat::F32 => data
            .as_slice::<f32>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::F64 => data
            .as_slice::<f64>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::I8 => data
            .as_slice::<i8>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::I16 => data
            .as_slice::<i16>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::I24 => data
            .as_slice::<cpal::I24>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::I32 => data
            .as_slice::<i32>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::I64 => data
            .as_slice::<i64>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::U8 => data
            .as_slice::<u8>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::U16 => data
            .as_slice::<u16>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::U24 => data
            .as_slice::<cpal::U24>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::U32 => data
            .as_slice::<u32>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::U64 => data
            .as_slice::<u64>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        _ => None,
    };
    pcm.ok_or_else(|| "The audio device returned an unsupported sample format.".to_owned())
}

pub(super) fn encode_samples<T>(samples: &[T], sample_format: &str) -> Vec<u8>
where
    T: Sample + SizedSample,
    f32: cpal::FromSample<T>,
    i16: cpal::FromSample<T>,
    i32: cpal::FromSample<T>,
    u8: cpal::FromSample<T>,
{
    let mut output = Vec::with_capacity(samples.len() * 4);
    match sample_format {
        "pcm_f32le" => {
            for sample in samples {
                output.extend_from_slice(&sample.to_sample::<f32>().to_le_bytes());
            }
        }
        "pcm_s16le" => {
            for sample in samples {
                output.extend_from_slice(&sample.to_sample::<i16>().to_le_bytes());
            }
        }
        "pcm_s24le" => {
            for sample in samples {
                let bytes = sample.to_sample::<i32>().to_le_bytes();
                output.extend_from_slice(&bytes[1..]);
            }
        }
        "pcm_s32le" => {
            for sample in samples {
                output.extend_from_slice(&sample.to_sample::<i32>().to_le_bytes());
            }
        }
        "pcm_u8" => {
            for sample in samples {
                output.push(sample.to_sample::<u8>());
            }
        }
        _ => {}
    }
    output
}

pub(super) fn data_to_float_samples(data: &Data) -> Option<Vec<f32>> {
    let interleaved = match data.sample_format() {
        SampleFormat::F32 => data.as_slice::<f32>().map(convert_samples),
        SampleFormat::F64 => data.as_slice::<f64>().map(convert_samples),
        SampleFormat::I8 => data.as_slice::<i8>().map(convert_samples),
        SampleFormat::I16 => data.as_slice::<i16>().map(convert_samples),
        SampleFormat::I24 => data.as_slice::<cpal::I24>().map(convert_samples),
        SampleFormat::I32 => data.as_slice::<i32>().map(convert_samples),
        SampleFormat::I64 => data.as_slice::<i64>().map(convert_samples),
        SampleFormat::U8 => data.as_slice::<u8>().map(convert_samples),
        SampleFormat::U16 => data.as_slice::<u16>().map(convert_samples),
        SampleFormat::U24 => data.as_slice::<cpal::U24>().map(convert_samples),
        SampleFormat::U32 => data.as_slice::<u32>().map(convert_samples),
        SampleFormat::U64 => data.as_slice::<u64>().map(convert_samples),
        SampleFormat::DsdU8 | SampleFormat::DsdU16 | SampleFormat::DsdU32 => None,
        _ => None,
    }?;
    Some(interleaved)
}

fn convert_samples<T: Sample + SizedSample>(samples: &[T]) -> Vec<f32>
where
    f32: cpal::FromSample<T>,
{
    samples
        .iter()
        .map(|sample| sample.to_sample::<f32>())
        .collect()
}
