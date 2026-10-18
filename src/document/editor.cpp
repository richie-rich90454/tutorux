#include "tutorux/document/editor.hpp"

#include <algorithm>
#include <limits>
#include <utility>

namespace tutorux::document {
namespace {

    core::Status validateUtf8(std::string_view text) {
        std::size_t offset = 0;
        while (offset < text.size()) {
            const auto first = static_cast<unsigned char>(text[offset]);
            std::size_t length = 0;
            std::uint32_t codePoint = 0;
            if (first <= 0x7fU) {
                length = 1;
                codePoint = first;
            } else if (first >= 0xc2U && first <= 0xdfU) {
                length = 2;
                codePoint = first & 0x1fU;
            } else if (first >= 0xe0U && first <= 0xefU) {
                length = 3;
                codePoint = first & 0x0fU;
            } else if (first >= 0xf0U && first <= 0xf4U) {
                length = 4;
                codePoint = first & 0x07U;
            } else {
                return std::unexpected(
                    core::error("document_utf8_invalid", "Document text contains invalid UTF-8."));
            }

            if (length > text.size() - offset) {
                return std::unexpected(
                    core::error("document_utf8_invalid",
                                "Document text ends inside a UTF-8 code point."));
            }
            for (std::size_t index = 1; index < length; ++index) {
                const auto continuation = static_cast<unsigned char>(text[offset + index]);
                if ((continuation & 0xc0U) != 0x80U) {
                    return std::unexpected(core::error("document_utf8_invalid",
                                                       "Document text contains invalid UTF-8."));
                }
                codePoint = (codePoint << 6U) | (continuation & 0x3fU);
            }
            const bool overlong = (length == 2 && codePoint < 0x80U) ||
                                  (length == 3 && codePoint < 0x800U) ||
                                  (length == 4 && codePoint < 0x10000U);
            if (overlong || codePoint > 0x10ffffU ||
                (codePoint >= 0xd800U && codePoint <= 0xdfffU)) {
                return std::unexpected(
                    core::error("document_utf8_invalid",
                                "Document text contains an invalid code point."));
            }
            offset += length;
        }
        return {};
    }

    bool isContinuationByte(char value) noexcept {
        return (static_cast<unsigned char>(value) & 0xc0U) == 0x80U;
    }

} // namespace

PieceTable::PieceTable(std::string original, std::vector<Piece> pieces)
    : original_(std::make_shared<const std::string>(std::move(original)))
    , pieces_(std::move(pieces))
    , size_(original_->size()) {}

core::Result<PieceTable> PieceTable::create(std::string initialText) {
    if (auto status = validateUtf8(initialText); !status)
        return std::unexpected(status.error());
    std::vector<Piece> pieces;
    if (!initialText.empty())
        pieces.push_back({Buffer::original, 0, 0, initialText.size()});
    return PieceTable(std::move(initialText), std::move(pieces));
}

std::size_t PieceTable::size() const noexcept {
    return size_;
}

bool PieceTable::empty() const noexcept {
    return size_ == 0;
}

std::string PieceTable::text() const {
    std::string result;
    result.reserve(size_);
    for (const auto& piece : pieces_) {
        const std::string& buffer = pieceBuffer(piece);
        result.append(buffer, piece.start, piece.length);
    }
    return result;
}

TextSelection PieceTable::selection() const noexcept {
    return selection_;
}

bool PieceTable::canUndo() const noexcept {
    return !undo_.empty();
}

bool PieceTable::canRedo() const noexcept {
    return !redo_.empty();
}

core::Result<EditResult> PieceTable::apply(const DocumentEditTransaction& transaction) {
    if (transaction.operations.empty()) {
        return EditResult{paragraphAt(selection_.focus), selection_, 0};
    }
    PieceTable candidate = *this;
    UndoEntry entry;
    entry.before = selection_;
    entry.after = transaction.selectionAfter;
    entry.operations.reserve(transaction.operations.size());
    TextRange changed{size_, 0};
    for (const auto& operation : transaction.operations) {
        auto removed = candidate.replaceWithoutHistory(
            {operation.offset, operation.offset + operation.removedText.size()},
            operation.insertedText);
        if (!removed)
            return std::unexpected(removed.error());
        if (!operation.removedText.empty() && *removed != operation.removedText) {
            return std::unexpected(core::error("document_edit_conflict",
                                               "The text removed by the edit no longer matches."));
        }
        entry.operations.push_back({operation.offset, operation.insertedText, std::move(*removed)});
        changed.start = std::min(changed.start, operation.offset);
        changed.end = std::max(changed.end, operation.offset + operation.insertedText.size());
    }

    if (!candidate.isBoundary(entry.after.anchor) || !candidate.isBoundary(entry.after.focus)) {
        return std::unexpected(
            core::error("document_selection_invalid", "The selection splits a UTF-8 code point."));
    }
    candidate.selection_ = entry.after;
    candidate.undo_.push_back(std::move(entry));
    candidate.redo_.clear();
    const auto invalidated = candidate.expandedParagraphRange(changed);
    *this = std::move(candidate);
    return EditResult{invalidated, selection_, transaction.operations.size()};
}

core::Result<EditResult> PieceTable::replace(TextRange range, std::string_view replacement) {
    if (range.start > range.end || range.end > size_ || !isBoundary(range.start) ||
        !isBoundary(range.end)) {
        return std::unexpected(
            core::error("document_range_invalid",
                        "The edit range is outside the document or UTF-8 boundary."));
    }
    DocumentEditTransaction transaction;
    transaction.selectionBefore = selection_;
    transaction.selectionAfter = {range.start + replacement.size(),
                                  range.start + replacement.size()};
    transaction.operations.push_back({range.start, std::string(replacement), slice(range)});
    return apply(transaction);
}

core::Result<EditResult> PieceTable::replaceAll(std::string_view query,
                                                std::string_view replacement) {
    if (query.empty()) {
        return std::unexpected(core::error("document_search_empty",
                                           "Find and replace requires non-empty search text."));
    }
    if (auto status = validateUtf8(query); !status)
        return std::unexpected(status.error());
    if (auto status = validateUtf8(replacement); !status)
        return std::unexpected(status.error());

    auto matches = findAll(query);
    std::erase_if(matches, [&](TextRange match) {
        return !isBoundary(match.start) || !isBoundary(match.end);
    });
    if (matches.empty())
        return EditResult{paragraphAt(selection_.focus), selection_, 0};

    const std::size_t count = matches.size();
    std::size_t updatedSize = size_;
    if (replacement.size() > query.size()) {
        const std::size_t growth = replacement.size() - query.size();
        if (growth > (std::numeric_limits<std::size_t>::max() - updatedSize) / count) {
            return std::unexpected(
                core::error("document_size_limit", "The edited document would be too large."));
        }
        updatedSize += growth * count;
    } else {
        updatedSize -= (query.size() - replacement.size()) * count;
    }

    DocumentEditTransaction transaction;
    transaction.selectionBefore = selection_;
    transaction.selectionAfter = {updatedSize, updatedSize};
    transaction.operations.reserve(matches.size());
    for (auto match = matches.rbegin(); match != matches.rend(); ++match) {
        transaction.operations.push_back(
            {match->start, std::string(replacement), std::string(query)});
    }
    return apply(transaction);
}

core::Result<EditResult> PieceTable::undo() {
    if (undo_.empty()) {
        return std::unexpected(
            core::error("document_undo_empty", "There is no document edit to undo."));
    }
    const UndoEntry entry = undo_.back();
    auto result = replay(entry, true);
    if (!result)
        return std::unexpected(result.error());
    undo_.pop_back();
    redo_.push_back(entry);
    selection_ = entry.before;
    result->selection = selection_;
    return result;
}

core::Result<EditResult> PieceTable::redo() {
    if (redo_.empty()) {
        return std::unexpected(
            core::error("document_redo_empty", "There is no document edit to redo."));
    }
    const UndoEntry entry = redo_.back();
    auto result = replay(entry, false);
    if (!result)
        return std::unexpected(result.error());
    redo_.pop_back();
    undo_.push_back(entry);
    selection_ = entry.after;
    result->selection = selection_;
    return result;
}

core::Result<std::size_t> PieceTable::previousCodePoint(std::size_t offset) const {
    if (offset > size_ || !isBoundary(offset)) {
        return std::unexpected(
            core::error("document_cursor_invalid",
                        "The cursor is outside the document or UTF-8 boundary."));
    }
    if (offset == 0)
        return 0;
    --offset;
    while (offset > 0 && isContinuationByte(byteAt(offset)))
        --offset;
    return offset;
}

core::Result<std::size_t> PieceTable::nextCodePoint(std::size_t offset) const {
    if (offset > size_ || !isBoundary(offset)) {
        return std::unexpected(
            core::error("document_cursor_invalid",
                        "The cursor is outside the document or UTF-8 boundary."));
    }
    if (offset == size_)
        return size_;
    ++offset;
    while (offset < size_ && isContinuationByte(byteAt(offset)))
        ++offset;
    return offset;
}

std::vector<TextRange> PieceTable::findAll(std::string_view query) const {
    std::vector<TextRange> matches;
    if (query.empty())
        return matches;
    const std::string contents = text();
    std::size_t position = 0;
    while ((position = contents.find(query, position)) != std::string::npos) {
        matches.push_back({position, position + query.size()});
        position += query.size();
    }
    return matches;
}

TextRange PieceTable::paragraphAt(std::size_t offset) const noexcept {
    offset = std::min(offset, size_);
    std::size_t start = offset;
    while (start > 0 && byteAt(start - 1) != '\n')
        --start;
    std::size_t end = offset;
    while (end < size_ && byteAt(end) != '\n')
        ++end;
    if (end < size_)
        ++end;
    return {start, end};
}

core::Status PieceTable::splitAt(std::size_t offset) {
    if (offset > size_ || !isBoundary(offset)) {
        return std::unexpected(
            core::error("document_range_invalid",
                        "The edit range is outside the document or UTF-8 boundary."));
    }
    std::size_t position = 0;
    for (auto piece = pieces_.begin(); piece != pieces_.end(); ++piece) {
        const std::size_t pieceEnd = position + piece->length;
        if (offset == position || offset == pieceEnd)
            return {};
        if (offset < pieceEnd) {
            const std::size_t leftLength = offset - position;
            const Piece right{piece->buffer,
                              piece->bufferIndex,
                              piece->start + leftLength,
                              piece->length - leftLength};
            piece->length = leftLength;
            pieces_.insert(piece + 1, right);
            return {};
        }
        position = pieceEnd;
    }
    return {};
}

core::Result<std::string> PieceTable::replaceWithoutHistory(TextRange range,
                                                            std::string_view replacement) {
    if (range.start > range.end || range.end > size_ || !isBoundary(range.start) ||
        !isBoundary(range.end)) {
        return std::unexpected(
            core::error("document_range_invalid",
                        "The edit range is outside the document or UTF-8 boundary."));
    }
    if (auto status = validateUtf8(replacement); !status)
        return std::unexpected(status.error());
    if (replacement.size() >
        std::numeric_limits<std::size_t>::max() - (size_ - (range.end - range.start))) {
        return std::unexpected(
            core::error("document_size_limit", "The edited document would be too large."));
    }

    std::string removed = slice(range);
    if (auto status = splitAt(range.end); !status)
        return std::unexpected(status.error());
    if (auto status = splitAt(range.start); !status)
        return std::unexpected(status.error());

    std::size_t position = 0;
    auto first = pieces_.end();
    auto last = pieces_.end();
    for (auto piece = pieces_.begin(); piece != pieces_.end(); ++piece) {
        if (position == range.start)
            first = piece;
        if (position == range.end) {
            last = piece;
            break;
        }
        position += piece->length;
    }
    if (range.start == range.end) {
        for (auto piece = pieces_.begin(); piece != pieces_.end(); ++piece) {
            if (position == range.start) {
                first = piece;
                break;
            }
            if (position > range.start)
                break;
            position += piece->length;
        }
        last = first;
    } else if (range.end == size_) {
        last = pieces_.end();
    }
    if (first == pieces_.end() && range.start == size_)
        first = pieces_.end();
    if (last == pieces_.end() && range.end != size_) {
        return std::unexpected(
            core::error("document_edit_internal", "Unable to locate the requested edit range."));
    }

    const std::size_t removedSize = range.end - range.start;
    const auto insertionPoint = pieces_.erase(first, last);
    if (!replacement.empty()) {
        const std::size_t additionIndex = additions_.size();
        additions_.push_back(std::make_shared<const std::string>(replacement));
        pieces_.insert(insertionPoint, {Buffer::additions, additionIndex, 0, replacement.size()});
    }
    size_ = size_ - removedSize + replacement.size();
    return removed;
}

core::Result<EditResult> PieceTable::replay(const UndoEntry& entry, bool inverse) {
    PieceTable candidate = *this;
    TextRange changed{size_, 0};
    if (inverse) {
        for (auto operation = entry.operations.rbegin(); operation != entry.operations.rend();
             ++operation) {
            auto status = candidate.replaceWithoutHistory(
                {operation->offset, operation->offset + operation->insertedText.size()},
                operation->removedText);
            if (!status)
                return std::unexpected(status.error());
            changed.start = std::min(changed.start, operation->offset);
            changed.end = std::max(changed.end, operation->offset + operation->removedText.size());
        }
    } else {
        for (const auto& operation : entry.operations) {
            auto status = candidate.replaceWithoutHistory(
                {operation.offset, operation.offset + operation.removedText.size()},
                operation.insertedText);
            if (!status)
                return std::unexpected(status.error());
            changed.start = std::min(changed.start, operation.offset);
            changed.end = std::max(changed.end, operation.offset + operation.insertedText.size());
        }
    }
    const auto invalidated = candidate.expandedParagraphRange(changed);
    *this = std::move(candidate);
    return EditResult{invalidated, selection_, entry.operations.size()};
}

const std::string& PieceTable::pieceBuffer(const Piece& piece) const noexcept {
    if (piece.buffer == Buffer::original)
        return *original_;
    return *additions_[piece.bufferIndex];
}

std::string PieceTable::slice(TextRange range) const {
    std::string result;
    result.reserve(range.end - range.start);
    std::size_t position = 0;
    for (const auto& piece : pieces_) {
        const std::size_t pieceEnd = position + piece.length;
        const std::size_t overlapStart = std::max(position, range.start);
        const std::size_t overlapEnd = std::min(pieceEnd, range.end);
        if (overlapStart < overlapEnd) {
            const std::string& buffer = pieceBuffer(piece);
            const std::size_t start = piece.start + overlapStart - position;
            result.append(buffer, start, overlapEnd - overlapStart);
        }
        if (pieceEnd >= range.end)
            break;
        position = pieceEnd;
    }
    return result;
}

char PieceTable::byteAt(std::size_t offset) const noexcept {
    if (offset >= size_)
        return '\0';
    std::size_t position = 0;
    for (const auto& piece : pieces_) {
        if (offset < position + piece.length) {
            const std::string& buffer = pieceBuffer(piece);
            return buffer[piece.start + offset - position];
        }
        position += piece.length;
    }
    return '\0';
}

bool PieceTable::isBoundary(std::size_t offset) const noexcept {
    return offset == 0 || offset == size_ || !isContinuationByte(byteAt(offset));
}

TextRange PieceTable::expandedParagraphRange(TextRange changedRange) const noexcept {
    const TextRange first = paragraphAt(std::min(changedRange.start, size_));
    const TextRange last = paragraphAt(std::min(changedRange.end, size_));
    return {first.start, std::max(first.end, last.end)};
}

} // namespace tutorux::document
