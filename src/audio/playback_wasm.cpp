#include "playback_platform.hpp"

#include <emscripten.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace tutorux::audio::detail {
namespace {

    constexpr std::size_t framesPerBuffer = 4'096;

    EM_ASYNC_JS(int, tutoruxPlayBrowserAudio,
                (const std::int16_t* samples, std::size_t frames, int channels, int sampleRate), {
                    try {
                        const frameCount = Number(frames);
                        const channelCount = Number(channels);
                        const firstSample = samples >> 1;
                        const sampleCount = frameCount * channelCount;
                        const samplesCopy = HEAP16.slice(firstSample, firstSample + sampleCount);
                        const channel = new MessageChannel();
                        const result = await new Promise((resolve) = > {
                            const timeout = setTimeout(() = > resolve(2), 30_000);
                            channel.port1.onmessage = (event) => {
                                clearTimeout(timeout);
                                resolve(Number(event.data?.result ?? 2));
                                channel.port1.close();
                            };
                            channel.port1.start();
                            globalThis.postMessage({
                                id : 0,
                                type : "play-audio",
                                ok : true,
                                frames : frameCount,
                                channels : channelCount,
                                sampleRate : Number(sampleRate),
                                samples : samplesCopy.buffer,
                            },
                                                   [ samplesCopy.buffer, channel.port2 ]);
                        });
                        return result;
                    } catch (error) {
                        return 2;
                    }
                });

} // namespace

core::Result<PcmPlaybackResult> playPcmSource(PcmPlaybackSource source) {
    if (!source.readFrames || source.sampleRateHz < 8'000 || source.sampleRateHz > 384'000 ||
        source.channelCount == 0 || source.channelCount > 8) {
        return std::unexpected(core::error(
            "audio_playback_format_invalid",
            "Playback requires 16-bit PCM with a supported sample rate and channel count."));
    }

    std::vector<std::int16_t> samples(framesPerBuffer * source.channelCount);
    PcmPlaybackResult playback;
    while (true) {
        if (source.stopRequested && source.stopRequested())
            break;
        auto frameCount = source.readFrames(samples);
        if (!frameCount)
            return std::unexpected(frameCount.error());
        if (*frameCount == 0) {
            playback.reachedEnd = true;
            break;
        }
        const int result = tutoruxPlayBrowserAudio(samples.data(), *frameCount, source.channelCount,
                                                   source.sampleRateHz);
        if (result == 3)
            break;
        if (result != 0) {
            return std::unexpected(core::error(
                "audio_playback_browser_failed",
                result == 1 ? "This browser does not provide the Web Audio playback interface."
                            : "The browser could not start or complete Web Audio playback."));
        }
        playback.playedFrames += *frameCount;
        if (source.progress)
            source.progress(playback.playedFrames);
    }
    return playback;
}

} // namespace tutorux::audio::detail
