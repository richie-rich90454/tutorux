#pragma once

#include "tutorux/archive/format.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <string>

namespace tutorux::domain {

    class Sha256Builder final {
      public:
        Sha256Builder() noexcept;

        void update(std::span<const std::byte> input) noexcept;
        std::array<std::byte, 32> finish() noexcept;

      private:
        void processBlock(const std::byte* block) noexcept;

        std::array<std::uint32_t, 8> state_{};
        std::array<std::byte, 64> buffer_{};
        std::array<std::byte, 32> digest_{};
        std::uint64_t byteCount_{};
        std::size_t bufferedSize_{};
        bool finished_{};
    };

    std::array<std::byte, 32> sha256(std::span<const std::byte> input);
    std::string hexHash(std::span<const std::byte> input);
    std::string hexHash(const std::array<std::byte, 32>& hash);

} // namespace tutorux::domain
