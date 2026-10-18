#include "tutorux/ai/embedded_llama.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <cctype>
#include <cstdint>
#include <fstream>
#include <limits>
#include <mutex>
#include <string>
#include <system_error>
#include <thread>
#include <utility>
#include <vector>

#if defined(TUTORUX_WITH_LLAMA)
#include <ggml.h>
#include <gguf.h>
#include <llama.h>
#endif

namespace tutorux::ai {
namespace {

    constexpr std::uint64_t maximumGgufFileBytes = 1ULL << 40U;
    constexpr std::uint64_t runtimeOverheadBytes = 256ULL * 1024ULL * 1024ULL;
    constexpr std::size_t maximumPromptBytes = 4U * 1024U * 1024U;
    constexpr std::size_t maximumGeneratedBytes = 8U * 1024U * 1024U;
    constexpr std::uint32_t maximumOutputTokens = 1'000'000;
    constexpr std::uint32_t maximumCpuThreadLimit = 64;
    constexpr std::uint32_t minimumContextTokens = 32;
    constexpr std::uint32_t maximumContextTokens = 1'048'576;

    std::string pathUtf8(const std::filesystem::path& path) {
        const std::u8string encoded = path.u8string();
        return {reinterpret_cast<const char*>(encoded.data()), encoded.size()};
    }

    std::string pathForMessage(const std::filesystem::path& path) {
        return pathUtf8(path);
    }

    std::uint32_t resolvedCpuThreads(const EmbeddedLlamaConfig& config) {
        const unsigned int detected = std::thread::hardware_concurrency();
        const std::uint32_t available = detected == 0U ? 1U : detected;
        const std::uint32_t requested = config.cpuThreads == 0U ? available : config.cpuThreads;
        return std::clamp(requested, 1U, config.maximumCpuThreads);
    }

    core::Status validateConfig(const EmbeddedLlamaConfig& config) {
        if (config.contextTokens < minimumContextTokens ||
            config.contextTokens > maximumContextTokens) {
            return std::unexpected(
                core::error("llama_context_configuration_invalid",
                            "The embedded model context must be between 32 and 1,048,576 tokens."));
        }
        if (config.maximumCpuThreads == 0U || config.maximumCpuThreads > maximumCpuThreadLimit) {
            return std::unexpected(
                core::error("llama_thread_configuration_invalid",
                            "The CPU thread limit must be between 1 and 64 threads."));
        }
        return {};
    }

    bool addSaturated(std::uint64_t left, std::uint64_t right, std::uint64_t& result) {
        if (right > std::numeric_limits<std::uint64_t>::max() - left) {
            result = std::numeric_limits<std::uint64_t>::max();
            return false;
        }
        result = left + right;
        return true;
    }

    bool multiplySaturated(std::uint64_t left, std::uint64_t right, std::uint64_t& result) {
        if (left != 0U && right > std::numeric_limits<std::uint64_t>::max() / left) {
            result = std::numeric_limits<std::uint64_t>::max();
            return false;
        }
        result = left * right;
        return true;
    }

    bool cancellationRequested(const std::function<bool()>& callback, bool& failed) {
        if (!callback)
            return false;
        try {
            return callback();
        } catch (...) {
            failed = true;
            return false;
        }
    }

#if defined(TUTORUX_WITH_LLAMA)

    std::mutex backendMutex;
    std::uint64_t backendLeaseCount{};

    void acquireBackend() {
        const std::lock_guard lock(backendMutex);
        if (backendLeaseCount == 0U)
            llama_backend_init();
        ++backendLeaseCount;
    }

    void releaseBackend() noexcept {
        const std::lock_guard lock(backendMutex);
        if (backendLeaseCount == 0U)
            return;
        --backendLeaseCount;
        if (backendLeaseCount == 0U)
            llama_backend_free();
    }

    std::string ggufString(const gguf_context* context, std::string_view key) {
        const std::string ownedKey(key);
        const std::int64_t index = gguf_find_key(context, ownedKey.c_str());
        if (index < 0 || gguf_get_kv_type(context, index) != GGUF_TYPE_STRING)
            return {};
        const char* value = gguf_get_val_str(context, index);
        return value ? std::string(value) : std::string{};
    }

    bool ggufUnsigned(const gguf_context* context, std::string_view key, std::uint64_t& value) {
        const std::string ownedKey(key);
        const std::int64_t index = gguf_find_key(context, ownedKey.c_str());
        if (index < 0)
            return false;

        switch (gguf_get_kv_type(context, index)) {
            case GGUF_TYPE_UINT8:
                value = gguf_get_val_u8(context, index);
                return true;
            case GGUF_TYPE_UINT16:
                value = gguf_get_val_u16(context, index);
                return true;
            case GGUF_TYPE_UINT32:
                value = gguf_get_val_u32(context, index);
                return true;
            case GGUF_TYPE_UINT64:
                value = gguf_get_val_u64(context, index);
                return true;
            case GGUF_TYPE_INT8: {
                const std::int8_t signedValue = gguf_get_val_i8(context, index);
                if (signedValue < 0)
                    return false;
                value = static_cast<std::uint64_t>(signedValue);
                return true;
            }
            case GGUF_TYPE_INT16: {
                const std::int16_t signedValue = gguf_get_val_i16(context, index);
                if (signedValue < 0)
                    return false;
                value = static_cast<std::uint64_t>(signedValue);
                return true;
            }
            case GGUF_TYPE_INT32: {
                const std::int32_t signedValue = gguf_get_val_i32(context, index);
                if (signedValue < 0)
                    return false;
                value = static_cast<std::uint64_t>(signedValue);
                return true;
            }
            case GGUF_TYPE_INT64: {
                const std::int64_t signedValue = gguf_get_val_i64(context, index);
                if (signedValue < 0)
                    return false;
                value = static_cast<std::uint64_t>(signedValue);
                return true;
            }
            default:
                return false;
        }
    }

    core::Result<EmbeddedLlamaModelInfo> inspectGgufWithLlama(const std::filesystem::path& path) {
        std::error_code filesystemError;
        if (!std::filesystem::is_regular_file(path, filesystemError) || filesystemError) {
            return std::unexpected(
                core::error("llama_model_file_invalid",
                            "The GGUF model path is not a readable regular file."));
        }

        const std::uint64_t fileSize = std::filesystem::file_size(path, filesystemError);
        if (filesystemError || fileSize < 24U || fileSize > maximumGgufFileBytes) {
            return std::unexpected(core::error(
                "llama_model_file_invalid",
                "The model file is empty, truncated, or larger than the 1 TiB safety limit."));
        }

        std::ifstream header(path, std::ios::binary);
        std::array<char, 4> magic{};
        if (!header.read(magic.data(), static_cast<std::streamsize>(magic.size())) ||
            magic != std::array<char, 4>{'G', 'G', 'U', 'F'}) {
            return std::unexpected(core::error("llama_model_format_invalid",
                                               "The selected model does not have a GGUF header."));
        }

        const std::string encodedPath = pathUtf8(path);
        ggml_context* tensorContext = nullptr;
        gguf_init_params parameters{};
        parameters.no_alloc = true;
        parameters.ctx = &tensorContext;
        gguf_context* gguf = gguf_init_from_file(encodedPath.c_str(), parameters);
        if (!gguf) {
            if (tensorContext)
                ggml_free(tensorContext);
            return std::unexpected(
                core::error("llama_model_format_invalid",
                            "llama.cpp could not parse the GGUF header or tensor index."));
        }

        EmbeddedLlamaModelInfo info;
        info.path = path;
        info.fileSizeBytes = fileSize;
        info.architecture = ggufString(gguf, "general.architecture");
        info.name = ggufString(gguf, "general.name");
        info.description = ggufString(gguf, "general.description");
        info.tensorCount = static_cast<std::uint64_t>(gguf_get_n_tensors(gguf));

        if (!info.architecture.empty()) {
            const std::string prefix = info.architecture + ".";
            static_cast<void>(
                ggufUnsigned(gguf, prefix + "context_length", info.contextTrainingTokens));
            static_cast<void>(
                ggufUnsigned(gguf, prefix + "embedding_length", info.embeddingLength));
            static_cast<void>(ggufUnsigned(gguf, prefix + "block_count", info.layerCount));
        }

        gguf_free(gguf);
        if (tensorContext)
            ggml_free(tensorContext);

        if (info.architecture.empty() || info.tensorCount == 0U ||
            info.contextTrainingTokens == 0U || info.embeddingLength == 0U ||
            info.layerCount == 0U) {
            return std::unexpected(core::error(
                "llama_model_format_invalid",
                "The GGUF model is missing a valid architecture, tensor index, or required "
                "context metadata."));
        }
        return info;
    }

    core::Result<std::vector<llama_token>> tokenizePrompt(const llama_vocab* vocabulary,
                                                          std::string_view prompt) {
        if (prompt.size() > maximumPromptBytes ||
            prompt.size() > static_cast<std::size_t>(std::numeric_limits<std::int32_t>::max())) {
            return std::unexpected(
                core::error("llama_prompt_too_large",
                            "The combined system and user prompt exceeds 4 MiB."));
        }

        const auto promptLength = static_cast<std::int32_t>(prompt.size());
        const std::int32_t tokenCount =
            llama_tokenize(vocabulary, prompt.data(), promptLength, nullptr, 0, true, false);
        if (tokenCount >= 0 || tokenCount == std::numeric_limits<std::int32_t>::min()) {
            return std::unexpected(core::error("llama_prompt_tokenization_failed",
                                               "llama.cpp could not tokenize the prompt."));
        }

        std::vector<llama_token> tokens(static_cast<std::size_t>(-tokenCount));
        const std::int32_t written = llama_tokenize(vocabulary,
                                                    prompt.data(),
                                                    promptLength,
                                                    tokens.data(),
                                                    tokenCount * -1,
                                                    true,
                                                    false);
        if (written < 0 || written != -tokenCount) {
            return std::unexpected(
                core::error("llama_prompt_tokenization_failed",
                            "llama.cpp returned an incomplete tokenized prompt."));
        }
        return tokens;
    }

    core::Result<std::string> tokenPiece(const llama_vocab* vocabulary, llama_token token) {
        std::vector<char> buffer(256U);
        std::int32_t pieceSize = llama_token_to_piece(vocabulary,
                                                      token,
                                                      buffer.data(),
                                                      static_cast<std::int32_t>(buffer.size()),
                                                      0,
                                                      false);
        if (pieceSize < 0) {
            if (pieceSize == std::numeric_limits<std::int32_t>::min() || -pieceSize > 1024 * 1024) {
                return std::unexpected(core::error("llama_token_piece_too_large",
                                                   "The model emitted an oversized token piece."));
            }
            buffer.resize(static_cast<std::size_t>(-pieceSize));
            pieceSize = llama_token_to_piece(vocabulary,
                                             token,
                                             buffer.data(),
                                             static_cast<std::int32_t>(buffer.size()),
                                             0,
                                             false);
        }
        if (pieceSize < 0 || static_cast<std::size_t>(pieceSize) > buffer.size()) {
            return std::unexpected(core::error("llama_token_decode_failed",
                                               "llama.cpp could not decode a generated token."));
        }
        return std::string(buffer.data(), static_cast<std::size_t>(pieceSize));
    }

#endif

} // namespace

core::Result<EmbeddedLlamaModelInfo> inspectEmbeddedGguf(const std::filesystem::path& path) {
#if defined(TUTORUX_WITH_LLAMA)
    return inspectGgufWithLlama(path);
#else
    static_cast<void>(path);
    return std::unexpected(
        core::error("llama_backend_unsupported",
                    "Embedded llama.cpp support is not included in this Tutorux build."));
#endif
}

core::Result<EmbeddedLlamaMemoryEstimate>
estimateEmbeddedLlamaMemory(const EmbeddedLlamaModelInfo& model,
                            const EmbeddedLlamaConfig& config) {
    if (auto status = validateConfig(config); !status)
        return std::unexpected(status.error());
    if (model.fileSizeBytes == 0U || model.embeddingLength == 0U || model.layerCount == 0U) {
        return std::unexpected(core::error(
            "llama_model_metadata_invalid",
            "Memory estimation requires a GGUF model inspection with dimensions and file size."));
    }

    EmbeddedLlamaMemoryEstimate estimate;
    estimate.modelBytes = model.fileSizeBytes;
    estimate.contextTokens = config.contextTokens;
    estimate.cpuThreads = resolvedCpuThreads(config);
    estimate.runtimeOverheadBytes = runtimeOverheadBytes;

    std::uint64_t contextBytes = config.contextTokens;
    bool valid = multiplySaturated(contextBytes, model.embeddingLength, contextBytes);
    valid = multiplySaturated(contextBytes, model.layerCount, contextBytes) && valid;
    valid = multiplySaturated(contextBytes, 4U, contextBytes) && valid;
    estimate.contextBytesUpperBound = contextBytes;

    std::uint64_t subtotal = 0;
    valid = addSaturated(estimate.modelBytes, estimate.contextBytesUpperBound, subtotal) && valid;
    valid = addSaturated(subtotal, estimate.runtimeOverheadBytes, estimate.totalBytesUpperBound) &&
            valid;
    estimate.overflowed = !valid;
    return estimate;
}

struct EmbeddedLlama::Impl final {
    mutable std::mutex mutex;
    EmbeddedLlamaConfig config;
    EmbeddedLlamaModelInfo info;
#if defined(TUTORUX_WITH_LLAMA)
    llama_model* model{};
    bool backendLease{};
#endif

    void unloadLocked() noexcept {
#if defined(TUTORUX_WITH_LLAMA)
        if (model) {
            llama_model_free(model);
            model = nullptr;
        }
        if (backendLease) {
            releaseBackend();
            backendLease = false;
        }
#endif
        info = {};
    }
};

EmbeddedLlama::EmbeddedLlama()
    : impl_(std::make_unique<Impl>()) {}

EmbeddedLlama::~EmbeddedLlama() {
    unload();
}

EmbeddedLlama::EmbeddedLlama(EmbeddedLlama&& other) noexcept = default;

EmbeddedLlama& EmbeddedLlama::operator=(EmbeddedLlama&& other) noexcept {
    if (this != &other) {
        unload();
        impl_ = std::move(other.impl_);
    }
    return *this;
}

core::Status EmbeddedLlama::load(const std::filesystem::path& modelPath,
                                 EmbeddedLlamaConfig config) {
#if defined(TUTORUX_WITH_LLAMA)
    if (!impl_)
        impl_ = std::make_unique<Impl>();
    const std::lock_guard lock(impl_->mutex);
    impl_->unloadLocked();

    if (auto status = validateConfig(config); !status)
        return status;
    auto inspected = inspectGgufWithLlama(modelPath);
    if (!inspected)
        return std::unexpected(inspected.error());
    if (config.gpuLayers > inspected->layerCount ||
        config.gpuLayers > static_cast<std::uint32_t>(std::numeric_limits<std::int32_t>::max())) {
        return std::unexpected(
            core::error("llama_gpu_layer_configuration_invalid",
                        "GPU layer offload must be between zero and the model's layer count."));
    }
#if !defined(TUTORUX_LLAMA_GPU_AVAILABLE)
    if (config.gpuLayers != 0U) {
        return std::unexpected(core::error(
            "llama_gpu_backend_unavailable",
            "This build has no enabled CUDA, Vulkan, or Metal backend for GPU offload."));
    }
#endif

    try {
        acquireBackend();
        impl_->backendLease = true;
        llama_model_params modelParameters = llama_model_default_params();
        modelParameters.n_gpu_layers = static_cast<std::int32_t>(config.gpuLayers);
        modelParameters.use_mmap = config.useMemoryMapping;
        modelParameters.use_mlock = config.lockModelPages;

        const std::string encodedPath = pathUtf8(modelPath);
        impl_->model = llama_model_load_from_file(encodedPath.c_str(), modelParameters);
        if (!impl_->model) {
            impl_->unloadLocked();
            return std::unexpected(core::error(
                "llama_model_load_failed",
                "llama.cpp validated the GGUF index but could not load the model weights."));
        }
        impl_->config = config;
        impl_->info = std::move(*inspected);
        return {};
    } catch (const std::exception& exception) {
        impl_->unloadLocked();
        return std::unexpected(core::error("llama_model_load_failed",
                                           "Unable to initialize the embedded model: " +
                                               std::string(exception.what())));
    } catch (...) {
        impl_->unloadLocked();
        return std::unexpected(
            core::error("llama_model_load_failed", "Unable to initialize the embedded model."));
    }
#else
    static_cast<void>(modelPath);
    static_cast<void>(config);
    return std::unexpected(
        core::error("llama_backend_unsupported",
                    "Embedded llama.cpp support is not included in this Tutorux build."));
#endif
}

void EmbeddedLlama::unload() noexcept {
    if (!impl_)
        return;
    const std::lock_guard lock(impl_->mutex);
    impl_->unloadLocked();
}

bool EmbeddedLlama::isLoaded() const {
    if (!impl_)
        return false;
    const std::lock_guard lock(impl_->mutex);
#if defined(TUTORUX_WITH_LLAMA)
    return impl_->model != nullptr;
#else
    return false;
#endif
}

core::Result<EmbeddedLlamaModelInfo> EmbeddedLlama::modelInfo() const {
    if (!impl_) {
        return std::unexpected(
            core::error("llama_model_not_loaded",
                        "Load a GGUF model before requesting model information."));
    }
    const std::lock_guard lock(impl_->mutex);
#if defined(TUTORUX_WITH_LLAMA)
    if (!impl_->model) {
        return std::unexpected(
            core::error("llama_model_not_loaded",
                        "Load a GGUF model before requesting model information."));
    }
    return impl_->info;
#else
    return std::unexpected(
        core::error("llama_backend_unsupported",
                    "Embedded llama.cpp support is not included in this Tutorux build."));
#endif
}

core::Result<EmbeddedLlamaGenerationResponse>
EmbeddedLlama::generate(EmbeddedLlamaGenerationRequest request) {
#if defined(TUTORUX_WITH_LLAMA)
    if (!impl_) {
        return std::unexpected(
            core::error("llama_model_not_loaded", "Load a GGUF model before generating text."));
    }
    const std::lock_guard lock(impl_->mutex);
    if (!impl_->model) {
        return std::unexpected(
            core::error("llama_model_not_loaded", "Load a GGUF model before generating text."));
    }
    if (request.maximumOutputTokens == 0U || request.maximumOutputTokens > maximumOutputTokens) {
        return std::unexpected(
            core::error("llama_output_limit_invalid",
                        "The output token limit must be between 1 and 1,000,000 tokens."));
    }

    bool cancellationCallbackFailed = false;
    if (cancellationRequested(request.cancelled, cancellationCallbackFailed)) {
        return std::unexpected(
            core::error("ai_request_cancelled", "The embedded inference request was cancelled."));
    }
    if (cancellationCallbackFailed) {
        return std::unexpected(core::error("ai_cancellation_callback_failed",
                                           "The cancellation callback raised an exception."));
    }

    const std::uint32_t threadCount = resolvedCpuThreads(impl_->config);
    try {
        llama_context_params contextParameters = llama_context_default_params();
        contextParameters.n_ctx = impl_->config.contextTokens;
        contextParameters.n_threads = static_cast<std::int32_t>(threadCount);
        contextParameters.n_threads_batch = static_cast<std::int32_t>(threadCount);

        llama_context* context = llama_init_from_model(impl_->model, contextParameters);
        if (!context) {
            return std::unexpected(core::error("llama_context_create_failed",
                                               "llama.cpp could not allocate a context for the "
                                               "requested token and thread limits."));
        }

        struct ContextGuard final {
            llama_context* value;
            ~ContextGuard() {
                if (value)
                    llama_free(value);
            }
        } contextGuard{context};

        std::string prompt;
        prompt.reserve(request.systemPrompt.size() + request.userContent.size() + 32U);
        if (!request.systemPrompt.empty()) {
            prompt.append("System:\n");
            prompt.append(request.systemPrompt);
            prompt.append("\n\n");
        }
        prompt.append("User:\n");
        prompt.append(request.userContent);
        prompt.append("\n\nAssistant:\n");

        const llama_vocab* vocabulary = llama_model_get_vocab(impl_->model);
        if (!vocabulary) {
            return std::unexpected(
                core::error("llama_model_invalid",
                            "The loaded GGUF model does not expose a tokenizer."));
        }

        auto promptTokens = tokenizePrompt(vocabulary, prompt);
        if (!promptTokens)
            return std::unexpected(promptTokens.error());
        if (promptTokens->empty() || promptTokens->size() >= impl_->config.contextTokens) {
            return std::unexpected(
                core::error("llama_context_exceeded",
                            "The prompt does not fit in the configured model context."));
        }

        const std::uint32_t availableOutputTokens =
            impl_->config.contextTokens - static_cast<std::uint32_t>(promptTokens->size());
        const std::uint32_t outputLimit =
            std::min(request.maximumOutputTokens, availableOutputTokens);
        if (outputLimit == 0U) {
            return std::unexpected(core::error(
                "llama_context_exceeded",
                "No context tokens remain for model output after encoding the prompt."));
        }

        llama_batch promptBatch =
            llama_batch_get_one(promptTokens->data(),
                                static_cast<std::int32_t>(promptTokens->size()));
        if (llama_decode(context, promptBatch) != 0) {
            return std::unexpected(core::error("llama_prompt_evaluation_failed",
                                               "llama.cpp could not evaluate the prompt."));
        }

        llama_sampler_chain_params samplerParameters = llama_sampler_chain_default_params();
        llama_sampler* sampler = llama_sampler_chain_init(samplerParameters);
        if (!sampler) {
            return std::unexpected(core::error("llama_sampler_create_failed",
                                               "llama.cpp could not initialize a sampler."));
        }

        struct SamplerGuard final {
            llama_sampler* value;
            ~SamplerGuard() {
                if (value)
                    llama_sampler_free(value);
            }
        } samplerGuard{sampler};
        llama_sampler_chain_add(sampler, llama_sampler_init_greedy());

        EmbeddedLlamaGenerationResponse response;
        response.modelName = impl_->info.name;
        response.content.reserve(std::min<std::size_t>(maximumGeneratedBytes, 4096U));

        for (std::uint32_t index = 0; index < outputLimit; ++index) {
            if (cancellationRequested(request.cancelled, cancellationCallbackFailed)) {
                return std::unexpected(
                    core::error("ai_request_cancelled",
                                "The embedded inference request was cancelled."));
            }
            if (cancellationCallbackFailed) {
                return std::unexpected(
                    core::error("ai_cancellation_callback_failed",
                                "The cancellation callback raised an exception."));
            }

            const llama_token token = llama_sampler_sample(sampler, context, -1);
            if (llama_vocab_is_eog(vocabulary, token))
                break;
            llama_sampler_accept(sampler, token);

            auto piece = tokenPiece(vocabulary, token);
            if (!piece)
                return std::unexpected(piece.error());
            if (piece->size() > maximumGeneratedBytes - response.content.size()) {
                return std::unexpected(
                    core::error("llama_output_too_large",
                                "Generated text exceeded the 8 MiB output limit."));
            }

            if (!piece->empty()) {
                response.content.append(*piece);
                if (request.onText) {
                    try {
                        request.onText(*piece);
                    } catch (...) {
                        return std::unexpected(core::error(
                            "ai_output_callback_failed",
                            "The output callback failed while receiving generated text."));
                    }
                }
            }
            ++response.generatedTokens;

            if (index + 1U < outputLimit) {
                llama_batch nextBatch = llama_batch_get_one(&token, 1);
                if (llama_decode(context, nextBatch) != 0) {
                    return std::unexpected(
                        core::error("llama_token_evaluation_failed",
                                    "llama.cpp could not evaluate a generated token."));
                }
            }
        }
        return response;
    } catch (const std::exception& exception) {
        return std::unexpected(
            core::error("llama_generation_failed",
                        "Embedded inference failed: " + std::string(exception.what())));
    } catch (...) {
        return std::unexpected(
            core::error("llama_generation_failed", "Embedded inference failed unexpectedly."));
    }
#else
    static_cast<void>(request);
    return std::unexpected(
        core::error("llama_backend_unsupported",
                    "Embedded llama.cpp support is not included in this Tutorux build."));
#endif
}

} // namespace tutorux::ai
