#pragma once

#include "tutorux/core/result.hpp"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace tutorux::document {

struct TextRange final {
    std::size_t start{};
    std::size_t end{};
};

struct TextSelection final {
    std::size_t anchor{};
    std::size_t focus{};
};

struct TextOperation final {
    std::size_t offset{};
    std::string insertedText;
    std::string removedText;
};

struct DocumentEditTransaction final {
    std::string documentId;
    std::uint64_t expectedRevision{};
    std::vector<TextOperation> operations;
    TextSelection selectionBefore;
    TextSelection selectionAfter;
    std::string origin{"user"};
    bool coalesceWithPrevious{};
};

struct EditResult final {
    TextRange invalidatedParagraphs;
    TextSelection selection;
    std::size_t operationCount{};
};

class PieceTable final {
  public:
    static core::Result<PieceTable> create(std::string initialText = {});

    PieceTable() = default;

    std::size_t size() const noexcept;
    bool empty() const noexcept;
    std::string text() const;
    TextSelection selection() const noexcept;
    bool canUndo() const noexcept;
    bool canRedo() const noexcept;

    core::Result<EditResult> apply(const DocumentEditTransaction& transaction);
    core::Result<EditResult> replace(TextRange range, std::string_view replacement);
    core::Result<EditResult> replaceAll(std::string_view query, std::string_view replacement);
    core::Result<EditResult> undo();
    core::Result<EditResult> redo();

    core::Result<std::size_t> previousCodePoint(std::size_t offset) const;
    core::Result<std::size_t> nextCodePoint(std::size_t offset) const;
    std::vector<TextRange> findAll(std::string_view query) const;
    TextRange paragraphAt(std::size_t offset) const noexcept;

  private:
    enum class Buffer : std::uint8_t {
        original,
        additions
    };

    struct Piece final {
        Buffer buffer{Buffer::original};
        std::size_t bufferIndex{};
        std::size_t start{};
        std::size_t length{};
    };

    struct UndoEntry final {
        std::vector<TextOperation> operations;
        TextSelection before;
        TextSelection after;
        std::string origin;
    };

    PieceTable(std::string original, std::vector<Piece> pieces);
    core::Status splitAt(std::size_t offset);
    core::Result<std::string> replaceWithoutHistory(TextRange range, std::string_view replacement);
    core::Result<EditResult> replay(const UndoEntry& entry, bool inverse);
    const std::string& pieceBuffer(const Piece& piece) const noexcept;
    std::string slice(TextRange range) const;
    char byteAt(std::size_t offset) const noexcept;
    bool isBoundary(std::size_t offset) const noexcept;
    TextRange expandedParagraphRange(TextRange changedRange) const noexcept;

    std::shared_ptr<const std::string> original_{std::make_shared<const std::string>()};
    std::vector<std::shared_ptr<const std::string>> additions_;
    std::vector<Piece> pieces_;
    std::size_t size_{};
    TextSelection selection_;
    std::vector<UndoEntry> undo_;
    std::vector<UndoEntry> redo_;
};

} // namespace tutorux::document
