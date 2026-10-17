#include "tutorux/domain/hash.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstdint>

namespace tutorux::domain {
    namespace {

        constexpr std::array<std::uint32_t, 64> kRoundConstants{
            0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U,
            0x923f82a4U, 0xab1c5ed5U, 0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
            0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U, 0xe49b69c1U, 0xefbe4786U,
            0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
            0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U,
            0x06ca6351U, 0x14292967U, 0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
            0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U, 0xa2bfe8a1U, 0xa81a664bU,
            0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
            0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU,
            0x5b9cca4fU, 0x682e6ff3U, 0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
            0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U};

        std::uint32_t readBigEndian(const std::byte* bytes) {
            return (std::to_integer<std::uint32_t>(bytes[0]) << 24U) |
                   (std::to_integer<std::uint32_t>(bytes[1]) << 16U) |
                   (std::to_integer<std::uint32_t>(bytes[2]) << 8U) |
                   std::to_integer<std::uint32_t>(bytes[3]);
        }

    } // namespace

    Sha256Builder::Sha256Builder() noexcept
        : state_{0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
                 0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U} {}

    void Sha256Builder::processBlock(const std::byte* block) noexcept {
        std::array<std::uint32_t, 64> words{};
        for (std::size_t index = 0; index < 16; ++index)
            words[index] = readBigEndian(block + index * 4);
        for (std::size_t index = 16; index < words.size(); ++index) {
            const auto s0 = std::rotr(words[index - 15], 7) ^ std::rotr(words[index - 15], 18) ^
                            (words[index - 15] >> 3U);
            const auto s1 = std::rotr(words[index - 2], 17) ^ std::rotr(words[index - 2], 19) ^
                            (words[index - 2] >> 10U);
            words[index] = words[index - 16] + s0 + words[index - 7] + s1;
        }
        auto a = state_[0];
        auto b = state_[1];
        auto c = state_[2];
        auto d = state_[3];
        auto e = state_[4];
        auto f = state_[5];
        auto g = state_[6];
        auto h = state_[7];
        for (std::size_t index = 0; index < words.size(); ++index) {
            const auto sum1 = std::rotr(e, 6) ^ std::rotr(e, 11) ^ std::rotr(e, 25);
            const auto choice = (e & f) ^ (~e & g);
            const auto temp1 = h + sum1 + choice + kRoundConstants[index] + words[index];
            const auto sum0 = std::rotr(a, 2) ^ std::rotr(a, 13) ^ std::rotr(a, 22);
            const auto majority = (a & b) ^ (a & c) ^ (b & c);
            const auto temp2 = sum0 + majority;
            h = g;
            g = f;
            f = e;
            e = d + temp1;
            d = c;
            c = b;
            b = a;
            a = temp1 + temp2;
        }
        state_[0] += a;
        state_[1] += b;
        state_[2] += c;
        state_[3] += d;
        state_[4] += e;
        state_[5] += f;
        state_[6] += g;
        state_[7] += h;
    }

    void Sha256Builder::update(std::span<const std::byte> input) noexcept {
        if (finished_ || input.empty())
            return;
        byteCount_ += static_cast<std::uint64_t>(input.size());
        std::size_t offset = 0;
        if (bufferedSize_ != 0) {
            const std::size_t copied = std::min(buffer_.size() - bufferedSize_, input.size());
            std::copy_n(input.begin(), copied, buffer_.begin() + bufferedSize_);
            bufferedSize_ += copied;
            offset += copied;
            if (bufferedSize_ == buffer_.size()) {
                processBlock(buffer_.data());
                bufferedSize_ = 0;
            }
        }
        while (input.size() - offset >= buffer_.size()) {
            processBlock(input.data() + offset);
            offset += buffer_.size();
        }
        if (offset < input.size()) {
            bufferedSize_ = input.size() - offset;
            std::copy_n(input.data() + offset, bufferedSize_, buffer_.begin());
        }
    }

    std::array<std::byte, 32> Sha256Builder::finish() noexcept {
        if (finished_)
            return digest_;
        const std::uint64_t bitLength = byteCount_ * 8U;
        buffer_[bufferedSize_++] = std::byte{0x80};
        if (bufferedSize_ > 56) {
            std::fill(buffer_.begin() + bufferedSize_, buffer_.end(), std::byte{});
            processBlock(buffer_.data());
            bufferedSize_ = 0;
        }
        std::fill(buffer_.begin() + bufferedSize_, buffer_.begin() + 56, std::byte{});
        for (std::size_t index = 0; index < 8; ++index) {
            buffer_[56 + index] = static_cast<std::byte>(
                (bitLength >> (56U - static_cast<unsigned int>(index) * 8U)) & 0xffU);
        }
        processBlock(buffer_.data());
        for (std::size_t index = 0; index < state_.size(); ++index) {
            for (std::size_t byteIndex = 0; byteIndex < 4; ++byteIndex) {
                digest_[index * 4 + byteIndex] = static_cast<std::byte>(
                    (state_[index] >> (24U - static_cast<unsigned int>(byteIndex) * 8U)) & 0xffU);
            }
        }
        finished_ = true;
        return digest_;
    }

    std::array<std::byte, 32> sha256(std::span<const std::byte> input) {
        Sha256Builder builder;
        builder.update(input);
        return builder.finish();
    }

    std::string hexHash(std::span<const std::byte> input) {
        return hexHash(sha256(input));
    }

    std::string hexHash(const std::array<std::byte, 32>& hash) {
        static constexpr char digits[] = "0123456789abcdef";
        std::string output;
        output.reserve(hash.size() * 2);
        for (std::byte byte : hash) {
            const auto value = std::to_integer<unsigned int>(byte);
            output.push_back(digits[(value >> 4U) & 0xfU]);
            output.push_back(digits[value & 0xfU]);
        }
        return output;
    }

} // namespace tutorux::domain
