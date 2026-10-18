#pragma once

#include "tutorux/ai/openai_compatible.hpp"
#include "tutorux/core/result.hpp"

#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace tutorux::ai {

struct EmbeddedLlamaModelInfo final {
    std::filesystem::path path;
    std::string architecture;
    std::string name;
    std::string description;
    std::uint64_t fileSizeBytes{};
    std::uint64_t contextTrainingTokens{};
    std::uint64_t embeddingLength{};
    std::uint64_t layerCount{};
    std::uint64_t tensorCount{};
};

struct EmbeddedLlamaConfig final {
    std::uint32_t contextTokens{4096};
    std::uint32_t cpuThreads{};
    std::uint32_t maximumCpuThreads{16};
    std::uint32_t gpuLayers{};
    bool useMemoryMapping{true};
    bool lockModelPages{};
};

struct EmbeddedLlamaMemoryEstimate final {
    std::uint64_t modelBytes{};
    std::uint64_t contextBytesUpperBound{};
    std::uint64_t runtimeOverheadBytes{};
    std::uint64_t totalBytesUpperBound{};
    std::uint32_t contextTokens{};
    std::uint32_t cpuThreads{};
    bool overflowed{};
};

struct EmbeddedLlamaGenerationRequest final {
    std::string systemPrompt;
    std::string userContent;
    std::vector<ContentPart> content;
    std::uint32_t maximumOutputTokens{1024};
    std::function<bool()> cancelled;
    std::function<void(std::string_view)> onText;
};

struct EmbeddedLlamaGenerationResponse final {
    std::string content;
    std::uint32_t generatedTokens{};
    std::string modelName;
};

core::Result<EmbeddedLlamaModelInfo> inspectEmbeddedGguf(const std::filesystem::path& path);

core::Result<EmbeddedLlamaMemoryEstimate>
estimateEmbeddedLlamaMemory(const EmbeddedLlamaModelInfo& model, const EmbeddedLlamaConfig& config);

class EmbeddedLlama final {
  public:
    EmbeddedLlama();
    ~EmbeddedLlama();

    EmbeddedLlama(const EmbeddedLlama&) = delete;
    EmbeddedLlama& operator=(const EmbeddedLlama&) = delete;
    EmbeddedLlama(EmbeddedLlama&& other) noexcept;
    EmbeddedLlama& operator=(EmbeddedLlama&& other) noexcept;

    core::Status load(const std::filesystem::path& modelPath, EmbeddedLlamaConfig config = {});
    void unload() noexcept;
    bool isLoaded() const;
    core::Result<EmbeddedLlamaModelInfo> modelInfo() const;

    core::Result<EmbeddedLlamaGenerationResponse> generate(EmbeddedLlamaGenerationRequest request);

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace tutorux::ai
