#include "tutorux/audio/screencapturekit_backend.hpp"

#include "tutorux/domain/entities.hpp"
#include "capture_observer.hpp"

#import <AVFAudio/AVFAudio.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreMedia/CoreMedia.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <dispatch/dispatch.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <charconv>
#include <cmath>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

namespace tutorux::audio {
struct CaptureQueue final {
    std::mutex mutex;
    std::condition_variable condition;
    std::vector<std::int16_t> samples;
    std::size_t queuedFrames{};
    std::uint64_t droppedFrames{};
    bool discontinuity{};
    bool paused{};
    bool stopping{};
    std::string failure;
};

namespace {

constexpr std::uint32_t sampleRateHz = 48'000;
constexpr std::uint16_t channelCount = 1;
constexpr std::size_t framesPerChunk = sampleRateHz / 10;
constexpr std::size_t maximumQueuedFrames = sampleRateHz * 4;
constexpr std::string_view kApplicationDevicePrefix = "screencapturekit-app:";

core::Result<pid_t> parseApplicationProcessId(std::string_view deviceId) {
    if (!deviceId.starts_with(kApplicationDevicePrefix)) {
        return std::unexpected(
            core::error("audio_device_id_invalid", "macOS application audio device IDs must use the ScreenCaptureKit app prefix."));
    }
    const std::string_view encodedId = deviceId.substr(kApplicationDevicePrefix.size());
    std::uint64_t processId = 0;
    const auto [end, error] = std::from_chars(encodedId.data(), encodedId.data() + encodedId.size(), processId);
    if (error != std::errc{} || end != encodedId.data() + encodedId.size() || processId == 0 ||
        processId > static_cast<std::uint64_t>(std::numeric_limits<pid_t>::max())) {
        return std::unexpected(core::error("audio_device_id_invalid", "The selected ScreenCaptureKit application ID is invalid."));
    }
    return static_cast<pid_t>(processId);
}

std::uint64_t samplesToMicroseconds(std::uint64_t samples) {
    const std::uint64_t seconds = samples / sampleRateHz;
    const std::uint64_t remainder = samples % sampleRateHz;
    return seconds * 1'000'000ULL + (remainder * 1'000'000ULL) / sampleRateHz;
}

std::uint64_t nowUnixMicroseconds() {
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
}

std::string screenCaptureErrorMessage(NSError* error, std::string_view operation) {
    if (!error)
        return std::string(operation) + " failed without an operating-system error detail.";
    const char* description = error.localizedDescription.UTF8String;
    return std::string(operation) + " failed: " + (description ? description : "unknown operating-system error");
}

core::Status appendAudioChunk(archive::Archive& archive, archive::Record& session, const archive::Uuid& sessionId,
                              const archive::Uuid& trackId, std::uint64_t sequence, std::uint64_t firstSample, std::uint64_t frameCount,
                              std::uint64_t gapBeforeSamples, std::uint64_t totalStoredSamples, std::uint64_t totalStoredBytes,
                              bool discontinuity, archive::Bytes payload) {
    if (firstSample > std::numeric_limits<std::uint64_t>::max() - frameCount ||
        totalStoredSamples > std::numeric_limits<std::uint64_t>::max() - frameCount ||
        payload.size() > std::numeric_limits<std::uint64_t>::max() - totalStoredBytes ||
        sequence == std::numeric_limits<std::uint64_t>::max()) {
        return std::unexpected(core::error("audio_capture_counter_invalid", "Recording counters overflowed."));
    }

    archive::Record chunk;
    chunk.type = archive::RecordType::AudioChunk;
    chunk.id = archive::randomUuid();
    chunk.fields = {{"session_id", archive::uuidToString(sessionId)},
                    {"track_id", archive::uuidToString(trackId)},
                    {"sequence_number", std::to_string(sequence)},
                    {"first_sample_index", std::to_string(firstSample)},
                    {"sample_count", std::to_string(frameCount)},
                    {"gap_before_samples", std::to_string(gapBeforeSamples)},
                    {"timeline_start_us", std::to_string(samplesToMicroseconds(firstSample))},
                    {"timeline_end_us", std::to_string(samplesToMicroseconds(firstSample + frameCount))},
                    {"sample_format", "pcm_s16le"},
                    {"sample_rate_hz", std::to_string(sampleRateHz)},
                    {"channel_count", std::to_string(channelCount)},
                    {"channel_mask", "0"},
                    {"codec", "none"},
                    {"source", "system-audio-loopback"},
                    {"contains_device_discontinuity", discontinuity ? "true" : "false"},
                    {"payload_checksum", std::to_string(archive::crc32(payload))}};
    chunk.blob = std::move(payload);

    session.fields["recording_audio_chunks"] = std::to_string(sequence + 1);
    session.fields["recording_samples"] = std::to_string(totalStoredSamples + frameCount);
    session.fields["recording_timeline_samples"] = std::to_string(firstSample + frameCount);
    session.fields["recording_bytes"] = std::to_string(totalStoredBytes + chunk.blob.size());
    session.fields["recording_state"] = "recording";
    session.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());

    std::vector<archive::Record> transaction;
    transaction.reserve(2);
    transaction.push_back(std::move(chunk));
    transaction.push_back(session);
    return archive.putMany(std::move(transaction));
}

core::Status updateCaptureState(archive::Archive& archive, archive::Record& session, std::string state, std::uint64_t chunkCount,
                                std::uint64_t storedSamples, std::uint64_t timelineSamples, std::uint64_t storedBytes,
                                std::string error = {}) {
    session.fields["recording_state"] = std::move(state);
    session.fields["recording_audio_chunks"] = std::to_string(chunkCount);
    session.fields["recording_samples"] = std::to_string(storedSamples);
    session.fields["recording_timeline_samples"] = std::to_string(timelineSamples);
    session.fields["recording_bytes"] = std::to_string(storedBytes);
    session.fields["recording_duration_us"] = std::to_string(samplesToMicroseconds(timelineSamples));
    session.fields["recording_error"] = std::move(error);
    session.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
    return archive.put(session);
}

core::Status getShareableContent(SCShareableContent* __strong* resultContent) {
    if (@available(macOS 13.0, *)) {
        __block SCShareableContent* content = nil;
        __block NSError* shareError = nil;
        dispatch_semaphore_t completion = dispatch_semaphore_create(0);
        [SCShareableContent getShareableContentExcludingDesktopWindows:YES
                                                   onScreenWindowsOnly:YES
                                                     completionHandler:^(SCShareableContent* result, NSError* error) {
                                                       content = result;
                                                       shareError = error;
                                                       dispatch_semaphore_signal(completion);
                                                     }];
        const auto deadline = dispatch_time(DISPATCH_TIME_NOW, 30LL * NSEC_PER_SEC);
        if (dispatch_semaphore_wait(completion, deadline) != 0) {
            return std::unexpected(core::error("audio_screen_capture_timeout",
                                               "ScreenCaptureKit did not finish the capture permission check within 30 seconds."));
        }
        if (shareError || !content) {
            return std::unexpected(core::error("audio_screen_capture_unavailable",
                                               screenCaptureErrorMessage(shareError, "Requesting ScreenCaptureKit access")));
        }
        if (content.displays.count == 0) {
            return std::unexpected(core::error("audio_screen_capture_display_missing", "ScreenCaptureKit found no available display."));
        }
        *resultContent = content;
        return {};
    }
    return std::unexpected(
        core::error("audio_screen_capture_unavailable", "ScreenCaptureKit system-audio capture requires macOS 13 or newer."));
}

bool appendSampleBuffer(CMSampleBufferRef sampleBuffer, AVAudioConverter*& converter, CaptureQueue& queue, std::string& error) {
    if (!CMSampleBufferDataIsReady(sampleBuffer))
        return true;
    const CMFormatDescriptionRef formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer);
    if (!formatDescription) {
        error = "ScreenCaptureKit returned audio without a format description.";
        return false;
    }

    AVAudioFormat* inputFormat = [[AVAudioFormat alloc] initWithCMAudioFormatDescription:formatDescription];
    if (!inputFormat || !inputFormat.streamDescription || inputFormat.streamDescription->mFormatID != kAudioFormatLinearPCM ||
        !std::isfinite(inputFormat.sampleRate) || inputFormat.sampleRate < 1.0) {
        error = "ScreenCaptureKit returned an unsupported non-PCM audio buffer.";
        return false;
    }

    const CMItemCount sampleCount = CMSampleBufferGetNumSamples(sampleBuffer);
    if (sampleCount <= 0 || static_cast<std::uint64_t>(sampleCount) > static_cast<std::uint64_t>(inputFormat.sampleRate * 2.0)) {
        error = "ScreenCaptureKit returned an invalid or oversized audio buffer.";
        return false;
    }

    constexpr std::size_t maximumAudioBuffers = 8;
    constexpr std::size_t bufferListSize = sizeof(AudioBufferList) + (maximumAudioBuffers - 1) * sizeof(AudioBuffer);
    std::vector<std::max_align_t> bufferListStorage((bufferListSize + sizeof(std::max_align_t) - 1) / sizeof(std::max_align_t));
    auto* sourceList = reinterpret_cast<AudioBufferList*>(bufferListStorage.data());
    CMBlockBufferRef retainedBlockBuffer = nullptr;
    size_t providedBufferListSize = bufferListSize;
    const OSStatus listStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer, &providedBufferListSize, sourceList, bufferListSize, kCFAllocatorDefault, kCFAllocatorDefault,
        kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, &retainedBlockBuffer);
    if (listStatus != noErr) {
        if (retainedBlockBuffer)
            CFRelease(retainedBlockBuffer);
        error = "ScreenCaptureKit could not copy the captured PCM samples.";
        return false;
    }
    if (sourceList->mNumberBuffers > maximumAudioBuffers) {
        if (retainedBlockBuffer)
            CFRelease(retainedBlockBuffer);
        error = "ScreenCaptureKit returned more audio channels than Tutorux can process.";
        return false;
    }

    const AVAudioFrameCount frames = static_cast<AVAudioFrameCount>(sampleCount);
    AVAudioPCMBuffer* inputBuffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:inputFormat frameCapacity:frames];
    if (!inputBuffer || sourceList->mNumberBuffers == 0 || inputBuffer.audioBufferList->mNumberBuffers != sourceList->mNumberBuffers) {
        if (retainedBlockBuffer)
            CFRelease(retainedBlockBuffer);
        error = "ScreenCaptureKit returned an inconsistent PCM channel layout.";
        return false;
    }

    bool copied = true;
    const auto* streamDescription = inputFormat.streamDescription;
    if (streamDescription->mBytesPerFrame == 0 || frames > std::numeric_limits<std::size_t>::max() / streamDescription->mBytesPerFrame) {
        if (retainedBlockBuffer)
            CFRelease(retainedBlockBuffer);
        error = "ScreenCaptureKit returned an invalid PCM frame size.";
        return false;
    }
    const std::size_t frameCapacityBytes = static_cast<std::size_t>(frames) * streamDescription->mBytesPerFrame;
    for (UInt32 index = 0; index < sourceList->mNumberBuffers; ++index) {
        const AudioBuffer& source = sourceList->mBuffers[index];
        AudioBuffer& destination = inputBuffer.audioBufferList->mBuffers[index];
        if (source.mDataByteSize > frameCapacityBytes || (source.mDataByteSize != 0 && (!source.mData || !destination.mData))) {
            copied = false;
            break;
        }
        if (source.mDataByteSize != 0)
            std::memcpy(destination.mData, source.mData, source.mDataByteSize);
        destination.mDataByteSize = source.mDataByteSize;
    }
    if (retainedBlockBuffer)
        CFRelease(retainedBlockBuffer);
    if (!copied) {
        error = "ScreenCaptureKit returned PCM data larger than its declared frame count.";
        return false;
    }
    inputBuffer.frameLength = frames;

    const auto capacityValue = static_cast<double>(frames) * static_cast<double>(sampleRateHz) / inputFormat.sampleRate + 512.0;
    if (capacityValue > static_cast<double>(std::numeric_limits<AVAudioFrameCount>::max())) {
        error = "ScreenCaptureKit audio conversion exceeded the supported buffer size.";
        return false;
    }
    const AVAudioFrameCount outputCapacity = static_cast<AVAudioFrameCount>(capacityValue);
    AVAudioFormat* outputFormat = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16
                                                                   sampleRate:sampleRateHz
                                                                     channels:channelCount
                                                                  interleaved:YES];
    if (!converter || ![converter.inputFormat isEqual:inputFormat])
        converter = [[AVAudioConverter alloc] initFromFormat:inputFormat toFormat:outputFormat];
    if (!converter) {
        error = "Tutorux could not create a ScreenCaptureKit PCM converter.";
        return false;
    }
    AVAudioPCMBuffer* outputBuffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:outputFormat frameCapacity:outputCapacity];
    if (!outputBuffer) {
        error = "Tutorux could not allocate a ScreenCaptureKit conversion buffer.";
        return false;
    }

    __block bool providedInput = false;
    NSError* conversionError = nil;
    const AVAudioConverterOutputStatus conversionStatus =
        [converter convertToBuffer:outputBuffer
                             error:&conversionError
                withInputFromBlock:^AVAudioBuffer*(AVAudioPacketCount, AVAudioConverterInputStatus* status) {
                  if (providedInput) {
                      *status = AVAudioConverterInputStatus_NoDataNow;
                      return nil;
                  }
                  providedInput = true;
                  *status = AVAudioConverterInputStatus_HaveData;
                  return inputBuffer;
                }];
    if (conversionStatus == AVAudioConverterOutputStatus_Error || conversionError) {
        error = screenCaptureErrorMessage(conversionError, "Converting captured audio");
        return false;
    }

    const AVAudioFrameCount outputFrames = outputBuffer.frameLength;
    if (outputFrames == 0)
        return true;
    const std::int16_t* outputSamples = outputBuffer.int16ChannelData[0];
    if (!outputSamples) {
        error = "Tutorux could not read the converted ScreenCaptureKit audio samples.";
        return false;
    }

    std::lock_guard lock(queue.mutex);
    const std::size_t frameCount = outputFrames;
    if (queue.paused || queue.stopping) {
        if (queue.droppedFrames <= std::numeric_limits<std::uint64_t>::max() - frameCount)
            queue.droppedFrames += frameCount;
        else
            queue.failure = "The ScreenCaptureKit audio gap counter overflowed.";
        queue.discontinuity = true;
    } else if (queue.queuedFrames > maximumQueuedFrames || frameCount > maximumQueuedFrames - queue.queuedFrames) {
        if (queue.droppedFrames <= std::numeric_limits<std::uint64_t>::max() - frameCount)
            queue.droppedFrames += frameCount;
        else
            queue.failure = "The ScreenCaptureKit audio gap counter overflowed.";
        queue.discontinuity = true;
    } else {
        queue.samples.insert(queue.samples.end(), outputSamples, outputSamples + frameCount);
        queue.queuedFrames += frameCount;
    }
    queue.condition.notify_one();
    return queue.failure.empty();
}

} // namespace

bool processScreenCaptureSampleBuffer(void* captureContext, CMSampleBufferRef sampleBuffer, AVAudioConverter*& converter,
                                      std::string& error) {
    if (!captureContext) {
        error = "ScreenCaptureKit audio capture context is unavailable.";
        return false;
    }
    auto& queue = *static_cast<CaptureQueue*>(captureContext);
    return appendSampleBuffer(sampleBuffer, converter, queue, error);
}

void processScreenCaptureStreamError(void* captureContext, NSError* error) {
    if (!captureContext)
        return;
    auto& queue = *static_cast<CaptureQueue*>(captureContext);
    std::lock_guard lock(queue.mutex);
    if (queue.failure.empty())
        queue.failure = screenCaptureErrorMessage(error, "ScreenCaptureKit stream");
    queue.condition.notify_one();
}

} // namespace tutorux::audio

@interface TutoruxScreenCaptureOutput : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, assign) void* captureQueue;
@property(nonatomic, strong) AVAudioConverter* converter;
@property(nonatomic, strong) dispatch_queue_t callbackQueue;
@end

@implementation TutoruxScreenCaptureOutput

- (void)stream:(SCStream*)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
    static_cast<void>(stream);
    if (type != SCStreamOutputTypeAudio || !self.captureQueue)
        return;
    auto& queue = *static_cast<tutorux::audio::CaptureQueue*>(self.captureQueue);
    std::string error;
    AVAudioConverter* converter = self.converter;
    bool succeeded = false;
    try {
        succeeded = tutorux::audio::processScreenCaptureSampleBuffer(self.captureQueue, sampleBuffer, converter, error);
    } catch (...) {
        error = "Tutorux could not allocate a ScreenCaptureKit audio buffer.";
    }
    self.converter = converter;
    if (!succeeded) {
        std::lock_guard lock(queue.mutex);
        if (queue.failure.empty())
            queue.failure = std::move(error);
        queue.condition.notify_one();
    }
}

- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
    static_cast<void>(stream);
    if (!self.captureQueue || !error)
        return;
    tutorux::audio::processScreenCaptureStreamError(self.captureQueue, error);
}

@end

namespace tutorux::audio {
namespace {

core::Status waitForStreamOperation(dispatch_semaphore_t completion, NSError** operationError, std::string_view operation) {
    const auto deadline = dispatch_time(DISPATCH_TIME_NOW, 15LL * NSEC_PER_SEC);
    if (dispatch_semaphore_wait(completion, deadline) != 0) {
        return std::unexpected(core::error("audio_screen_capture_timeout", std::string(operation) + " did not finish within 15 seconds."));
    }
}
else {
    self.converter = converter;
    if (*operationError) {
        return std::unexpected(core::error("audio_screen_capture_failed", screenCaptureErrorMessage(*operationError, operation)));
    }
    return {};
}

core::Status setStreamRunning(SCStream* stream, bool running) {
    if (@available(macOS 13.0, *)) {
        __block NSError* operationError = nil;
        dispatch_semaphore_t completion = dispatch_semaphore_create(0);
        if (running) {
            [stream startCaptureWithCompletionHandler:^(NSError* error) {
              operationError = error;
              dispatch_semaphore_signal(completion);
            }];
        } else {
            [stream stopCaptureWithCompletionHandler:^(NSError* error) {
              operationError = error;
              dispatch_semaphore_signal(completion);
            }];
        }
        return waitForStreamOperation(completion, &operationError,
                                      running ? "Starting system-audio capture" : "Pausing system-audio capture");
    }
    return std::unexpected(
        core::error("audio_screen_capture_unavailable", "ScreenCaptureKit system-audio capture requires macOS 13 or newer."));
}

core::Status createAudioStream(CaptureQueue& captureQueue, TutoruxScreenCaptureOutput* output, const CaptureOptions& options,
                               std::string& applicationName, std::string& applicationBundleId, SCStream* __strong* resultStream) {
    if (@available(macOS 13.0, *)) {
        SCShareableContent* content = nil;
        if (auto status = getShareableContent(&content); !status)
            return status;

        SCDisplay* display = content.displays.firstObject;
        SCContentFilter* filter = nil;
        if (options.source == DeviceKind::application) {
            if (@available(macOS 14.0, *)) {
                auto requestedProcessId = parseApplicationProcessId(options.deviceId);
                if (!requestedProcessId)
                    return std::unexpected(requestedProcessId.error());
                SCRunningApplication* selectedApplication = nil;
                for (SCRunningApplication* application in content.applications) {
                    if (application.processID == *requestedProcessId) {
                        selectedApplication = application;
                        break;
                    }
                }
                if (!selectedApplication) {
                    return std::unexpected(core::error("audio_application_not_running",
                                                       "The selected application is no longer available to ScreenCaptureKit."));
                }
                filter = [[SCContentFilter alloc] initWithDisplay:display
                                            includingApplications:@[ selectedApplication ]
                                                 exceptingWindows:@[]];
                const char* name = selectedApplication.applicationName.UTF8String;
                const char* bundleId = selectedApplication.bundleIdentifier.UTF8String;
                applicationName = name ? name : "Unknown application";
                applicationBundleId = bundleId ? bundleId : "";
            } else {
                return std::unexpected(core::error("audio_application_capture_unsupported",
                                                   "Per-application ScreenCaptureKit audio requires macOS 14 or newer."));
            }
        } else {
            filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
        }
        SCStreamConfiguration* configuration = [[SCStreamConfiguration alloc] init];
        configuration.capturesAudio = YES;
        configuration.excludesCurrentProcessAudio = YES;
        configuration.sampleRate = sampleRateHz;
        configuration.channelCount = 2;
        configuration.width = 2;
        configuration.height = 2;

        AVAudioFormat* inputFormat = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:sampleRateHz channels:2];
        AVAudioFormat* outputFormat = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16
                                                                       sampleRate:sampleRateHz
                                                                         channels:channelCount
                                                                      interleaved:YES];
        AVAudioConverter* converter = [[AVAudioConverter alloc] initFromFormat:inputFormat toFormat:outputFormat];
        if (!converter) {
            return std::unexpected(
                core::error("audio_screen_capture_converter_failed", "Tutorux could not create the ScreenCaptureKit PCM converter."));
        }
        output.captureQueue = &captureQueue;
        output.converter = converter;
        SCStream* stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:output];
        output.callbackQueue = dispatch_queue_create("app.tutorux.system-audio", DISPATCH_QUEUE_SERIAL);
        NSError* addOutputError = nil;
        if (![stream addStreamOutput:output type:SCStreamOutputTypeAudio sampleHandlerQueue:output.callbackQueue error:&addOutputError]) {
            return std::unexpected(core::error("audio_screen_capture_output_failed",
                                               screenCaptureErrorMessage(addOutputError, "Attaching the audio capture output")));
        }
        *resultStream = stream;
        return {};
    }
    return std::unexpected(
        core::error("audio_screen_capture_unavailable", "ScreenCaptureKit system-audio capture requires macOS 13 or newer."));
}

} // namespace

core::Result<CaptureDeviceProbe> probeScreenCaptureKitDevice(std::string deviceId) {
    if (!deviceId.empty() && deviceId != "screen-capture-kit" && deviceId != "default") {
        return std::unexpected(
            core::error("audio_device_id_invalid", "macOS system audio uses the ScreenCaptureKit device ID 'screen-capture-kit'."));
    }
    if (@available(macOS 13.0, *))
        return CaptureDeviceProbe{"screen-capture-kit", "pcm_s16le", sampleRateHz, channelCount};
    return std::unexpected(
        core::error("audio_screen_capture_unavailable", "ScreenCaptureKit system-audio capture requires macOS 13 or newer."));
}

core::Result<std::vector<DeviceInfo>> enumerateScreenCaptureKitApplications() {
    if (@available(macOS 14.0, *)) {
        SCShareableContent* content = nil;
        if (auto status = getShareableContent(&content); !status)
            return std::unexpected(status.error());

        std::vector<DeviceInfo> devices;
        devices.reserve(content.applications.count);
        for (SCRunningApplication* application in content.applications) {
            if (application.processID <= 0 || application.processID == NSProcessInfo.processInfo.processIdentifier) {
                continue;
            }
            const char* name = application.applicationName.UTF8String;
            const char* bundleId = application.bundleIdentifier.UTF8String;
            const std::string applicationName = name ? name : "Unknown application";
            const std::string applicationBundleId = bundleId ? bundleId : "";
            const auto processId = static_cast<std::uint64_t>(application.processID);
            devices.push_back({
                std::string(kApplicationDevicePrefix) + std::to_string(processId),
                applicationName + (applicationBundleId.empty() ? "" : " (" + applicationBundleId + ")") + " (process " +
                    std::to_string(processId) + ")",
                DeviceKind::application,
                false,
            });
        }
        return devices;
    }
    return std::unexpected(
        core::error("audio_application_capture_unsupported", "Per-application ScreenCaptureKit audio requires macOS 14 or newer."));
}

core::Result<CaptureDeviceProbe> probeScreenCaptureKitApplication(std::string deviceId) {
    auto requestedProcessId = parseApplicationProcessId(deviceId);
    if (!requestedProcessId)
        return std::unexpected(requestedProcessId.error());
    if (@available(macOS 14.0, *)) {
        SCShareableContent* content = nil;
        if (auto status = getShareableContent(&content); !status)
            return std::unexpected(status.error());
        for (SCRunningApplication* application in content.applications) {
            if (application.processID == *requestedProcessId) {
                if (application.processID == NSProcessInfo.processInfo.processIdentifier) {
                    return std::unexpected(
                        core::error("audio_application_capture_unsupported", "Tutorux cannot capture its own process audio."));
                }
                return CaptureDeviceProbe{std::move(deviceId), "pcm_s16le", sampleRateHz, channelCount};
            }
        }
        return std::unexpected(
            core::error("audio_application_not_running", "The selected application is no longer available to ScreenCaptureKit."));
    }
    return std::unexpected(
        core::error("audio_application_capture_unsupported", "Per-application ScreenCaptureKit audio requires macOS 14 or newer."));
}

core::Result<CaptureSummary> captureScreenCaptureKit(archive::Archive& archive, const archive::Uuid& sessionId, CaptureOptions options) {
    if (options.source != DeviceKind::playback && options.source != DeviceKind::application) {
        return std::unexpected(
            core::error("audio_source_invalid", "ScreenCaptureKit supports system audio or a selected application audio track."));
    }
    auto device = options.source == DeviceKind::application ? probeScreenCaptureKitApplication(options.deviceId)
                                                            : probeScreenCaptureKitDevice(options.deviceId);
    if (!device)
        return std::unexpected(device.error());
    if (options.maximumDuration && options.maximumDuration->count() <= 0) {
        return std::unexpected(core::error("audio_capture_duration_invalid", "Maximum capture duration must be positive."));
    }

    auto sessionResult = archive.get(archive::RecordType::Session, sessionId);
    if (!sessionResult)
        return std::unexpected(sessionResult.error());
    if (!*sessionResult || domain::isDeleted(**sessionResult)) {
        return std::unexpected(core::error("session_not_found", "Session was not found in the archive."));
    }
    archive::Record session = std::move(**sessionResult);
    const std::string previousState = domain::getField(session, "recording_state");
    if (previousState == "initializing" || previousState == "recording" || previousState == "paused" || previousState == "finalizing") {
        return std::unexpected(core::error("audio_capture_session_busy", "Session already has an active recording."));
    }

    bool sessionHasAudio = false;
    if (auto status = archive.forEachAudioChunk(sessionId, options.trackId,
                                                [&](archive::Record&&) {
                                                    sessionHasAudio = true;
                                                    return false;
                                                });
        !status) {
        return std::unexpected(status.error());
    }
    if (sessionHasAudio) {
        return std::unexpected(core::error("audio_capture_audio_exists", "Session already contains audio on the selected track."));
    }

    CaptureSummary summary;
    summary.trackId = options.trackId.value_or(archive::randomUuid());
    summary.deviceId = device->deviceId;
    summary.sampleFormat = "pcm_s16le";
    summary.sampleRateHz = sampleRateHz;
    summary.channelCount = channelCount;
    summary.channelMask = 0;
    const std::string sourceName = options.source == DeviceKind::application ? "application-audio" : "system-audio-loopback";
    session.fields["recording_track_id"] = archive::uuidToString(summary.trackId);
    session.fields["recording_source"] = sourceName;
    session.fields["recording_source_backend"] = "screencapturekit";
    session.fields["recording_device_id"] = summary.deviceId;
    session.fields["recording_consent"] = "explicit";
    session.fields["recording_consent_confirmed_by"] = options.consentConfirmedBy;
    session.fields["recording_consent_sources"] = sourceName;
    session.fields["recording_consent_policy_version"] = "1";
    if (options.source == DeviceKind::application) {
        auto processId = parseApplicationProcessId(summary.deviceId);
        if (!processId)
            return std::unexpected(processId.error());
        session.fields["recording_application_process_id"] = std::to_string(*processId);
    }
    session.fields["recording_durability"] = options.durability == DurabilityPolicy::maximum        ? "maximum"
                                             : options.durability == DurabilityPolicy::reducedWrite ? "reduced-write"
                                                                                                    : "default";
    session.fields["recording_consent_confirmed_by"] = options.consentConfirmedBy;
    const std::uint64_t recordingStartedAtUs = nowUnixMicroseconds();
    session.fields["recording_started_at_us"] = std::to_string(recordingStartedAtUs);
    session.fields["recording_audio_chunks"] = "0";
    session.fields["recording_samples"] = "0";
    session.fields["recording_timeline_samples"] = "0";
    session.fields["recording_bytes"] = "0";
    session.fields["recording_error"] = "";
    if (auto status = updateCaptureState(archive, session, "initializing", 0, 0, 0, 0); !status)
        return std::unexpected(status.error());

    CaptureQueue captureQueue;
    captureQueue.samples.reserve(maximumQueuedFrames);
    TutoruxScreenCaptureOutput* output = [[TutoruxScreenCaptureOutput alloc] init];
    SCStream* stream = nil;
    std::string applicationName;
    std::string applicationBundleId;
    if (auto status = createAudioStream(captureQueue, output, options, applicationName, applicationBundleId, &stream); !status) {
        const auto error = status.error();
        static_cast<void>(updateCaptureState(archive, session, "failed", 0, 0, 0, 0, error.message));
        return std::unexpected(error);
    }
    if (options.source == DeviceKind::application) {
        session.fields["recording_application_name"] = applicationName;
        session.fields["recording_application_bundle_id"] = applicationBundleId;
        if (auto status = archive.put(session); !status)
            return std::unexpected(status.error());
    }

    if (options.waitForSynchronizedStart && !options.waitForSynchronizedStart()) {
        static_cast<void>(updateCaptureState(archive, session, "failed", 0, 0, 0, 0, "A synchronized capture peer failed to start."));
        return std::unexpected(core::error("audio_capture_peer_failed", "A synchronized capture peer failed before both tracks started."));
    }
    if (options.stopRequested && options.stopRequested()) {
        static_cast<void>(updateCaptureState(archive, session, "failed", 0, 0, 0, 0, "Capture was cancelled before it started."));
        return std::unexpected(core::error("audio_capture_cancelled", "Capture was cancelled before it started."));
    }

    if (auto status = setStreamRunning(stream, true); !status) {
        const auto error = status.error();
        static_cast<void>(updateCaptureState(archive, session, "failed", 0, 0, 0, 0, error.message));
        return std::unexpected(error);
    }

    summary.state = "recording";
    session.fields["recording_state"] = "recording";
    session.fields["recording_source_device_id"] = "screen-capture-kit";
    if (auto status = archive.put(session); !status) {
        static_cast<void>(setStreamRunning(stream, false));
        return std::unexpected(status.error());
    }
    if (options.stateChanged)
        options.stateChanged("recording", "ScreenCaptureKit system-audio capture is active.");

    std::vector<std::int16_t> pending;
    pending.reserve(framesPerChunk);
    std::vector<std::int16_t> nextSamples;
    nextSamples.reserve(maximumQueuedFrames);
    std::uint64_t sequence = 0;
    std::uint64_t firstSample = 0;
    std::uint64_t storedSamples = 0;
    std::uint64_t storedBytes = 0;
    std::uint64_t gapBeforeNextChunk = 0;
    bool discontinuityNextChunk = false;
    bool streamRunning = true;
    bool userStopped = false;
    bool maximumDurationReached = false;
    std::string captureFailure;
    const auto captureStart = std::chrono::steady_clock::now();
    std::chrono::steady_clock::time_point pausedAt{};
    std::chrono::steady_clock::duration totalPausedDuration{};

    auto persistPending = [&](std::size_t frameCount) -> core::Status {
        if (frameCount == 0)
            return {};
        if (gapBeforeNextChunk > std::numeric_limits<std::uint64_t>::max() - firstSample) {
            return std::unexpected(core::error("audio_capture_counter_invalid", "Recording timeline overflowed."));
        }
        firstSample += gapBeforeNextChunk;
        archive::Bytes payload(frameCount * sizeof(std::int16_t));
        std::memcpy(payload.data(), pending.data(), payload.size());
        archive::Bytes observerSamples;
        if (options.pcmChunk && !summary.pcmObserverFailure)
            observerSamples = payload;
        auto status = appendAudioChunk(archive, session, sessionId, summary.trackId, sequence, firstSample, frameCount, gapBeforeNextChunk,
                                       storedSamples, storedBytes, discontinuityNextChunk, std::move(payload));
        if (!status)
            return status;
        if (!observerSamples.empty()) {
            detail::notifyPcmChunk(options, summary, recordingStartedAtUs, firstSample, frameCount, observerSamples);
        }
        const std::uint64_t byteCount = frameCount * sizeof(std::int16_t);
        if (storedSamples > std::numeric_limits<std::uint64_t>::max() - frameCount ||
            storedBytes > std::numeric_limits<std::uint64_t>::max() - byteCount ||
            firstSample > std::numeric_limits<std::uint64_t>::max() - frameCount) {
            return std::unexpected(core::error("audio_capture_counter_invalid", "Recording counters overflowed."));
        }
        ++sequence;
        storedSamples += frameCount;
        storedBytes += byteCount;
        firstSample += frameCount;
        summary.chunkCount = sequence;
        summary.sampleCount = storedSamples;
        summary.timelineSampleCount = firstSample;
        summary.byteCount = storedBytes;
        summary.durationUs = samplesToMicroseconds(firstSample);
        pending.erase(pending.begin(), pending.begin() + static_cast<std::ptrdiff_t>(frameCount));
        gapBeforeNextChunk = 0;
        discontinuityNextChunk = false;
        if (options.progress)
            options.progress(summary);
        return {};
    };

    auto updateStream = [&](bool shouldRun) -> core::Status {
        if (streamRunning == shouldRun)
            return {};
        if (auto status = setStreamRunning(stream, shouldRun); !status)
            return status;
        streamRunning = shouldRun;
        {
            std::lock_guard lock(captureQueue.mutex);
            captureQueue.paused = !shouldRun;
            captureQueue.discontinuity = true;
        }
        const auto now = std::chrono::steady_clock::now();
        if (shouldRun) {
            if (pausedAt != std::chrono::steady_clock::time_point{}) {
                totalPausedDuration += now - pausedAt;
                pausedAt = {};
            }
        } else {
            pausedAt = now;
        }
        if (options.stateChanged) {
            options.stateChanged(shouldRun ? "recording" : "paused", shouldRun ? "ScreenCaptureKit system-audio capture resumed."
                                                                               : "ScreenCaptureKit system-audio capture is paused.");
        }
        return {};
    };

    while (true) {
        const bool stopRequested = options.stopRequested && options.stopRequested();
        if (stopRequested) {
            userStopped = true;
            break;
        }
        const bool pauseRequested = options.pauseRequested && options.pauseRequested();
        if (auto status = updateStream(!pauseRequested); !status) {
            captureFailure = status.error().message;
            break;
        }
        auto activeDuration = std::chrono::steady_clock::now() - captureStart - totalPausedDuration;
        if (pausedAt != std::chrono::steady_clock::time_point{})
            activeDuration -= std::chrono::steady_clock::now() - pausedAt;
        if (options.maximumDuration && activeDuration >= *options.maximumDuration) {
            maximumDurationReached = true;
            break;
        }

        std::vector<std::int16_t> nextSamples;
        std::uint64_t droppedFrames = 0;
        bool discontinuity = false;
        {
            std::unique_lock lock(captureQueue.mutex);
            captureQueue.condition.wait_for(lock, std::chrono::milliseconds(20), [&] {
                return !captureQueue.samples.empty() || captureQueue.droppedFrames != 0 || !captureQueue.failure.empty();
            });
            if (!captureQueue.failure.empty()) {
                captureFailure = captureQueue.failure;
                captureQueue.failure.clear();
            }
            droppedFrames = std::exchange(captureQueue.droppedFrames, 0);
            discontinuity = std::exchange(captureQueue.discontinuity, false);
            if (!captureQueue.samples.empty()) {
                nextSamples.assign(captureQueue.samples.begin(), captureQueue.samples.end());
                captureQueue.samples.clear();
                captureQueue.queuedFrames = 0;
            }
        }
        if (droppedFrames > std::numeric_limits<std::uint64_t>::max() - gapBeforeNextChunk) {
            captureFailure = "The ScreenCaptureKit audio timeline overflowed.";
            break;
        }
        gapBeforeNextChunk += droppedFrames;
        discontinuityNextChunk = discontinuityNextChunk || discontinuity || droppedFrames != 0;
        pending.insert(pending.end(), nextSamples.begin(), nextSamples.end());
        while (pending.size() >= framesPerChunk) {
            if (auto status = persistPending(framesPerChunk); !status) {
                captureFailure = status.error().message;
                break;
            }
        }
        if (!captureFailure.empty())
            break;
    }

    {
        std::lock_guard lock(captureQueue.mutex);
        captureQueue.stopping = true;
    }
    if (streamRunning) {
        if (auto status = setStreamRunning(stream, false); !status && captureFailure.empty())
            captureFailure = status.error().message;
    }
    output.captureQueue = nullptr;
    dispatch_sync(output.callbackQueue, ^{
                  });
    {
        std::lock_guard lock(captureQueue.mutex);
        const std::uint64_t droppedFrames = std::exchange(captureQueue.droppedFrames, 0);
        if (droppedFrames > std::numeric_limits<std::uint64_t>::max() - gapBeforeNextChunk) {
            if (captureFailure.empty())
                captureFailure = "The ScreenCaptureKit audio timeline overflowed.";
        } else {
            gapBeforeNextChunk += droppedFrames;
        }
        discontinuityNextChunk = discontinuityNextChunk || captureQueue.discontinuity || droppedFrames != 0;
        if (captureFailure.empty() && !captureQueue.failure.empty())
            captureFailure = captureQueue.failure;
        pending.insert(pending.end(), captureQueue.samples.begin(), captureQueue.samples.end());
        captureQueue.samples.clear();
        captureQueue.queuedFrames = 0;
    }
    while (pending.size() >= framesPerChunk && captureFailure.empty()) {
        if (auto status = persistPending(framesPerChunk); !status)
            captureFailure = status.error().message;
    }
    if (!pending.empty() && captureFailure.empty()) {
        if (auto status = persistPending(pending.size()); !status)
            captureFailure = status.error().message;
    }

    summary.completed = captureFailure.empty() && (userStopped || maximumDurationReached);
    summary.state = summary.completed ? "completed" : summary.chunkCount > 0 ? "partial" : "failed";
    const std::string finalError = std::move(captureFailure);
    if (auto status = updateCaptureState(archive, session, summary.state, summary.chunkCount, summary.sampleCount,
                                         summary.timelineSampleCount, summary.byteCount, finalError);
        !status) {
        return std::unexpected(status.error());
    }
    if (options.stateChanged) {
        options.stateChanged(summary.state, summary.completed        ? "System-audio capture was committed."
                                            : summary.chunkCount > 0 ? "System-audio capture ended with recoverable audio."
                                                                     : "System-audio capture ended before audio was committed.");
    }
    if (!finalError.empty() && summary.chunkCount == 0) {
        return std::unexpected(core::error("audio_capture_failed", finalError));
    }
    return summary;
}

} // namespace tutorux::audio
