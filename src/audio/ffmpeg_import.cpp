#include "tutorux/audio/wav_import.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#ifdef TUTORUX_WITH_FFMPEG
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/error.h>
#include <libavutil/samplefmt.h>
#include <libswresample/swresample.h>
}
#endif

namespace tutorux::audio {
namespace {

    std::string lowercaseExtension(const std::filesystem::path& source) {
        std::string extension = source.extension().string();
        std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char c) {
            return static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c);
        });
        return extension;
    }

#ifdef TUTORUX_WITH_FFMPEG
    std::string ffmpegError(int code) {
        std::array<char, AV_ERROR_MAX_STRING_SIZE> buffer{};
        if (av_strerror(code, buffer.data(), buffer.size()) != 0)
            return "unknown FFmpeg error";
        return buffer.data();
    }

    class FfmpegPcmDecoder final {
      public:
        static core::Result<std::unique_ptr<FfmpegPcmDecoder>> open(const std::filesystem::path& path) {
            auto decoder = std::unique_ptr<FfmpegPcmDecoder>(new FfmpegPcmDecoder());
            if (auto status = decoder->initialize(path); !status)
                return std::unexpected(status.error());
            return std::move(decoder);
        }

        ~FfmpegPcmDecoder() {
            if (swr_)
                swr_free(&swr_);
            if (frame_)
                av_frame_free(&frame_);
            if (packet_)
                av_packet_free(&packet_);
            if (codec_)
                avcodec_free_context(&codec_);
            if (format_)
                avformat_close_input(&format_);
            av_channel_layout_uninit(&channelLayout_);
        }

        FfmpegPcmDecoder(const FfmpegPcmDecoder&) = delete;
        FfmpegPcmDecoder& operator=(const FfmpegPcmDecoder&) = delete;

        std::uint32_t sampleRateHz() const noexcept {
            return sampleRateHz_;
        }
        std::uint16_t channelCount() const noexcept {
            return channelCount_;
        }
        std::uint32_t channelMask() const noexcept {
            return 0;
        }

        core::Result<archive::Bytes> read(std::size_t exactByteCount) {
            const std::size_t blockAlign = static_cast<std::size_t>(channelCount_) * 2U;
            if (exactByteCount % blockAlign != 0) {
                return std::unexpected(core::error("audio_import_chunk_invalid", "Requested decoded audio is not frame-aligned."));
            }
            archive::Bytes output;
            output.reserve(exactByteCount);
            while (output.size() < exactByteCount) {
                if (pendingOffset_ < pending_.size()) {
                    const std::size_t available = pending_.size() - pendingOffset_;
                    const std::size_t requested = exactByteCount - output.size();
                    const std::size_t count = std::min(available, requested);
                    for (std::size_t index = 0; index < count; ++index)
                        output.push_back(pending_[pendingOffset_ + index]);
                    pendingOffset_ += count;
                    if (pendingOffset_ == pending_.size()) {
                        pending_.clear();
                        pendingOffset_ = 0;
                    }
                    continue;
                }
                if (decoderEnded_)
                    break;
                if (auto status = decodeNext(); !status)
                    return std::unexpected(status.error());
            }
            return output;
        }

      private:
        FfmpegPcmDecoder() = default;

        core::Status initialize(const std::filesystem::path& path) {
            const std::string pathString = path.string();
            int code = avformat_open_input(&format_, pathString.c_str(), nullptr, nullptr);
            if (code < 0) {
                return std::unexpected(
                    core::error("audio_decode_open_failed", "FFmpeg could not open the audio source: " + ffmpegError(code)));
            }
            code = avformat_find_stream_info(format_, nullptr);
            if (code < 0) {
                return std::unexpected(
                    core::error("audio_decode_probe_failed", "FFmpeg could not inspect the audio source: " + ffmpegError(code)));
            }
            const AVCodec* decoder = nullptr;
            audioStreamIndex_ = av_find_best_stream(format_, AVMEDIA_TYPE_AUDIO, -1, -1, &decoder, 0);
            if (audioStreamIndex_ < 0 || !decoder) {
                return std::unexpected(core::error("audio_decode_stream_missing", "The source has no decodable audio stream."));
            }
            codec_ = avcodec_alloc_context3(decoder);
            if (!codec_) {
                return std::unexpected(core::error("audio_decode_allocation_failed", "FFmpeg could not allocate an audio decoder."));
            }
            AVStream* stream = format_->streams[audioStreamIndex_];
            code = avcodec_parameters_to_context(codec_, stream->codecpar);
            if (code < 0) {
                return std::unexpected(
                    core::error("audio_decode_configure_failed", "FFmpeg could not configure the audio decoder: " + ffmpegError(code)));
            }
            code = avcodec_open2(codec_, decoder, nullptr);
            if (code < 0) {
                return std::unexpected(
                    core::error("audio_decode_open_failed", "FFmpeg could not initialize the audio decoder: " + ffmpegError(code)));
            }
            if (codec_->sample_rate < 8'000 || codec_->sample_rate > 384'000 || codec_->ch_layout.nb_channels == 0 ||
                codec_->ch_layout.nb_channels > 8) {
                return std::unexpected(core::error("audio_decode_format_unsupported",
                                                   "Decoded audio must have a sample rate from 8,000 through 384,000 Hz and "
                                                   "one through eight channels."));
            }
            sampleRateHz_ = static_cast<std::uint32_t>(codec_->sample_rate);
            channelCount_ = static_cast<std::uint16_t>(codec_->ch_layout.nb_channels);
            code = av_channel_layout_copy(&channelLayout_, &codec_->ch_layout);
            if (code < 0) {
                return std::unexpected(
                    core::error("audio_decode_configure_failed", "FFmpeg could not copy the audio channel layout: " + ffmpegError(code)));
            }
            code = swr_alloc_set_opts2(&swr_, &channelLayout_, AV_SAMPLE_FMT_S16, codec_->sample_rate, &channelLayout_, codec_->sample_fmt,
                                       codec_->sample_rate, 0, nullptr);
            if (code < 0 || !swr_) {
                return std::unexpected(
                    core::error("audio_decode_resampler_failed", "FFmpeg could not configure PCM conversion: " + ffmpegError(code)));
            }
            code = swr_init(swr_);
            if (code < 0) {
                return std::unexpected(
                    core::error("audio_decode_resampler_failed", "FFmpeg could not initialize PCM conversion: " + ffmpegError(code)));
            }
            packet_ = av_packet_alloc();
            frame_ = av_frame_alloc();
            if (!packet_ || !frame_) {
                return std::unexpected(core::error("audio_decode_allocation_failed", "FFmpeg could not allocate audio buffers."));
            }
            return {};
        }

        core::Status appendFrame(const AVFrame* frame) {
            const int outputCapacity = swr_get_out_samples(swr_, frame->nb_samples);
            if (outputCapacity < 0) {
                return std::unexpected(core::error("audio_decode_resampler_failed", "FFmpeg could not size the converted audio."));
            }
            const std::size_t maximumBytes = static_cast<std::size_t>(outputCapacity) * channelCount_ * sizeof(std::int16_t);
            std::vector<std::uint8_t> converted(maximumBytes);
            std::uint8_t* outputPlanes[] = {converted.data()};
            const std::uint8_t** inputPlanes = const_cast<const std::uint8_t**>(frame->extended_data);
            const int convertedFrames = swr_convert(swr_, outputPlanes, outputCapacity, inputPlanes, frame->nb_samples);
            if (convertedFrames < 0) {
                return std::unexpected(core::error("audio_decode_resampler_failed",
                                                   "FFmpeg could not convert an audio frame: " + ffmpegError(convertedFrames)));
            }
            converted.resize(static_cast<std::size_t>(convertedFrames) * channelCount_ * sizeof(std::int16_t));
            if constexpr (std::endian::native == std::endian::big) {
                for (std::size_t index = 0; index + 1 < converted.size(); index += 2)
                    std::swap(converted[index], converted[index + 1]);
            }
            pending_.reserve(pending_.size() + converted.size());
            for (const auto byte : converted)
                pending_.push_back(static_cast<std::byte>(byte));
            return {};
        }

        core::Status flushResampler() {
            const int outputCapacity = swr_get_out_samples(swr_, 0);
            if (outputCapacity <= 0)
                return {};
            const std::size_t maximumBytes = static_cast<std::size_t>(outputCapacity) * channelCount_ * sizeof(std::int16_t);
            std::vector<std::uint8_t> converted(maximumBytes);
            std::uint8_t* outputPlanes[] = {converted.data()};
            const int convertedFrames = swr_convert(swr_, outputPlanes, outputCapacity, nullptr, 0);
            if (convertedFrames < 0) {
                return std::unexpected(core::error("audio_decode_resampler_failed",
                                                   "FFmpeg could not flush converted audio: " + ffmpegError(convertedFrames)));
            }
            converted.resize(static_cast<std::size_t>(convertedFrames) * channelCount_ * sizeof(std::int16_t));
            if constexpr (std::endian::native == std::endian::big) {
                for (std::size_t index = 0; index + 1 < converted.size(); index += 2)
                    std::swap(converted[index], converted[index + 1]);
            }
            for (const auto byte : converted)
                pending_.push_back(static_cast<std::byte>(byte));
            return {};
        }

        core::Status decodeNext() {
            while (pending_.empty() && !decoderEnded_) {
                int code = avcodec_receive_frame(codec_, frame_);
                if (code == 0) {
                    auto status = appendFrame(frame_);
                    av_frame_unref(frame_);
                    if (!status)
                        return status;
                    if (!pending_.empty())
                        return {};
                    continue;
                }
                if (code == AVERROR_EOF) {
                    if (auto status = flushResampler(); !status)
                        return status;
                    decoderEnded_ = true;
                    return {};
                }
                if (code != AVERROR(EAGAIN)) {
                    return std::unexpected(
                        core::error("audio_decode_failed", "FFmpeg could not decode the audio source: " + ffmpegError(code)));
                }
                if (demuxEnded_) {
                    if (!flushSent_) {
                        code = avcodec_send_packet(codec_, nullptr);
                        if (code < 0 && code != AVERROR_EOF) {
                            return std::unexpected(
                                core::error("audio_decode_failed", "FFmpeg could not finish the audio decoder: " + ffmpegError(code)));
                        }
                        flushSent_ = true;
                        continue;
                    }
                    return std::unexpected(core::error("audio_decode_failed", "FFmpeg decoder stopped before reporting end of stream."));
                }
                while ((code = av_read_frame(format_, packet_)) >= 0) {
                    if (packet_->stream_index != audioStreamIndex_) {
                        av_packet_unref(packet_);
                        continue;
                    }
                    code = avcodec_send_packet(codec_, packet_);
                    av_packet_unref(packet_);
                    if (code < 0) {
                        return std::unexpected(
                            core::error("audio_decode_failed", "FFmpeg could not submit an audio packet: " + ffmpegError(code)));
                    }
                    break;
                }
                if (code == AVERROR_EOF)
                    demuxEnded_ = true;
                else if (code < 0) {
                    return std::unexpected(
                        core::error("audio_decode_read_failed", "FFmpeg could not read the audio source: " + ffmpegError(code)));
                }
            }
            return {};
        }

        AVFormatContext* format_{};
        AVCodecContext* codec_{};
        SwrContext* swr_{};
        AVPacket* packet_{};
        AVFrame* frame_{};
        AVChannelLayout channelLayout_{};
        int audioStreamIndex_{-1};
        std::uint32_t sampleRateHz_{};
        std::uint16_t channelCount_{};
        archive::Bytes pending_;
        std::size_t pendingOffset_{};
        bool demuxEnded_{};
        bool flushSent_{};
        bool decoderEnded_{};
    };

    core::Result<std::uint64_t> countDecodedSamples(const std::filesystem::path& source, const PcmImportSource& format) {
        auto decoderResult = FfmpegPcmDecoder::open(source);
        if (!decoderResult)
            return std::unexpected(decoderResult.error());
        const std::size_t blockAlign = static_cast<std::size_t>(format.channelCount) * 2U;
        constexpr std::size_t probeChunkBytes = 1024U * 1024U;
        std::uint64_t sampleCount = 0;
        while (true) {
            const std::size_t requestBytes = probeChunkBytes - probeChunkBytes % blockAlign;
            auto chunk = (*decoderResult)->read(requestBytes);
            if (!chunk)
                return std::unexpected(chunk.error());
            if (chunk->empty())
                break;
            if (chunk->size() % blockAlign != 0 || sampleCount > std::numeric_limits<std::uint64_t>::max() - chunk->size() / blockAlign) {
                return std::unexpected(core::error("audio_decode_length_invalid", "Decoded audio length exceeds supported limits."));
            }
            sampleCount += chunk->size() / blockAlign;
        }
        if (sampleCount == 0) {
            return std::unexpected(core::error("audio_decode_content_missing", "Audio source decoded to no samples."));
        }
        return sampleCount;
    }
#endif

} // namespace

core::Result<ImportSummary> importAudio(archive::Archive& archive, const archive::Uuid& sessionId, const std::filesystem::path& source,
                                        bool allowAdditionalTrack) {
    std::error_code errorCode;
    const auto status = std::filesystem::symlink_status(source, errorCode);
    if (errorCode || std::filesystem::is_symlink(status) || !std::filesystem::is_regular_file(status)) {
        return std::unexpected(core::error("audio_source_invalid", "Audio source must be a regular, non-symlink file."));
    }
    const std::string extension = lowercaseExtension(source);
    if (extension == ".wav" || extension == ".wave")
        return importWave(archive, sessionId, source, allowAdditionalTrack);
    if (extension != ".flac" && extension != ".mp3" && extension != ".m4a") {
        return std::unexpected(core::error("audio_extension_unsupported", "Audio import supports WAV, FLAC, MP3, and M4A sources."));
    }
#ifdef TUTORUX_WITH_FFMPEG
    auto decoderResult = FfmpegPcmDecoder::open(source);
    if (!decoderResult)
        return std::unexpected(decoderResult.error());
    PcmImportSource format;
    format.sampleRateHz = (*decoderResult)->sampleRateHz();
    format.channelCount = (*decoderResult)->channelCount();
    format.channelMask = (*decoderResult)->channelMask();
    format.sampleFormat = "pcm_s16le";
    format.sourceCodec = extension.substr(1);
    decoderResult->reset();
    auto sampleCount = countDecodedSamples(source, format);
    if (!sampleCount)
        return std::unexpected(sampleCount.error());
    format.sampleCount = *sampleCount;
    decoderResult = FfmpegPcmDecoder::open(source);
    if (!decoderResult)
        return std::unexpected(decoderResult.error());
    auto* decoder = decoderResult->get();
    PcmChunkReader reader = [decoder](std::size_t byteCount) {
        return decoder->read(byteCount);
    };
    return importPcmStream(archive, sessionId, source, std::move(format), std::move(reader), allowAdditionalTrack);
#else
    return std::unexpected(
        core::error("audio_codec_support_unavailable", "FLAC, MP3, and M4A import require a build with bundled static FFmpeg support."));
#endif
}

} // namespace tutorux::audio
