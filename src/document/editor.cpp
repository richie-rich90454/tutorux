#include "tutorux/document/editor.hpp"

#include "tutorux/document/unicode_grapheme_tables.hpp"

#include <algorithm>
#include <iterator>
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
                return std::unexpected(core::error(
                    "document_utf8_invalid", "Document text ends inside a UTF-8 code point."));
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
                return std::unexpected(core::error(
                    "document_utf8_invalid", "Document text contains an invalid code point."));
            }
            offset += length;
        }
        return {};
    }

    bool isContinuationByte(char value) noexcept {
        return (static_cast<unsigned char>(value) & 0xc0U) == 0x80U;
    }

    bool isUtf8Boundary(std::string_view text, std::size_t offset) noexcept {
        return offset == 0 || offset >= text.size() ||
               (static_cast<unsigned char>(text[offset]) & 0xc0U) != 0x80U;
    }

    using unicode::GraphemeCategory;

    struct DecodedScalar final {
        char32_t value{};
        std::size_t byteOffset{};
        GraphemeCategory category{GraphemeCategory::any};
        bool indicExtend{};
        bool indicLinker{};
    };

    GraphemeCategory graphemeCategory(char32_t value) noexcept {
        if (value <= 0x7eU) {
            if (value == U'\n')
                return GraphemeCategory::lf;
            if (value == U'\r')
                return GraphemeCategory::cr;
            return value >= 0x20U ? GraphemeCategory::any : GraphemeCategory::control;
        }
        const auto found =
            std::lower_bound(unicode::graphemeRanges.begin(), unicode::graphemeRanges.end(), value,
                             [](const unicode::GraphemeRange& range, char32_t scalar) {
                                 return range.last < scalar;
                             });
        if (found == unicode::graphemeRanges.end() || found->first > value)
            return GraphemeCategory::any;
        return found->category;
    }

    DecodedScalar decodeScalar(std::string_view text, std::size_t offset) noexcept {
        const auto first = static_cast<unsigned char>(text[offset]);
        char32_t value = first;
        std::size_t length = 1;
        if (first >= 0xf0U) {
            value = first & 0x07U;
            length = 4;
        } else if (first >= 0xe0U) {
            value = first & 0x0fU;
            length = 3;
        } else if (first >= 0xc0U) {
            value = first & 0x1fU;
            length = 2;
        }
        for (std::size_t index = 1; index < length; ++index) {
            value = (value << 6U) | (static_cast<unsigned char>(text[offset + index]) & 0x3fU);
        }

        const auto indicRange =
            std::lower_bound(unicode::indicExtendRanges.begin(), unicode::indicExtendRanges.end(),
                             value, [](const unicode::ScalarRange& range, char32_t scalar) {
                                 return range.last < scalar;
                             });
        const bool indicExtend =
            indicRange != unicode::indicExtendRanges.end() && indicRange->first <= value;
        const bool indicLinker =
            std::binary_search(unicode::indicLinkers.begin(), unicode::indicLinkers.end(), value);
        return {value, offset, graphemeCategory(value), indicExtend, indicLinker};
    }

    std::vector<DecodedScalar> decodeScalars(std::string_view text) {
        std::vector<DecodedScalar> scalars;
        scalars.reserve(text.size());
        for (std::size_t offset = 0; offset < text.size();) {
            auto scalar = decodeScalar(text, offset);
            offset += scalar.value <= 0x7fU     ? 1U
                      : scalar.value <= 0x7ffU  ? 2U
                      : scalar.value <= 0xffffU ? 3U
                                                : 4U;
            scalars.push_back(scalar);
        }
        return scalars;
    }

    bool isControl(GraphemeCategory category) noexcept {
        return category == GraphemeCategory::control || category == GraphemeCategory::cr ||
               category == GraphemeCategory::lf;
    }

    bool isGraphemeBreak(const std::vector<DecodedScalar>& scalars, std::size_t index) noexcept {
        const auto before = scalars[index - 1U].category;
        const auto after = scalars[index].category;
        if (before == GraphemeCategory::cr && after == GraphemeCategory::lf)
            return false;
        if (isControl(before) || isControl(after))
            return true;

        if (before == GraphemeCategory::hangulL &&
            (after == GraphemeCategory::hangulL || after == GraphemeCategory::hangulV ||
             after == GraphemeCategory::hangulLv || after == GraphemeCategory::hangulLvt)) {
            return false;
        }
        if ((before == GraphemeCategory::hangulLv || before == GraphemeCategory::hangulV) &&
            (after == GraphemeCategory::hangulV || after == GraphemeCategory::hangulT)) {
            return false;
        }
        if ((before == GraphemeCategory::hangulLvt || before == GraphemeCategory::hangulT) &&
            after == GraphemeCategory::hangulT) {
            return false;
        }
        if (after == GraphemeCategory::extend || after == GraphemeCategory::zeroWidthJoiner ||
            after == GraphemeCategory::spacingMark || before == GraphemeCategory::prepend) {
            return false;
        }

        if (after == GraphemeCategory::indicConsonant) {
            bool hasLinker = false;
            std::size_t previous = index;
            while (previous > 0) {
                const auto& scalar = scalars[previous - 1U];
                if (scalar.indicLinker) {
                    hasLinker = true;
                    --previous;
                } else if (scalar.indicExtend) {
                    --previous;
                } else {
                    break;
                }
            }
            if (hasLinker && previous > 0 &&
                scalars[previous - 1U].category == GraphemeCategory::indicConsonant) {
                return false;
            }
        }

        if (before == GraphemeCategory::zeroWidthJoiner &&
            after == GraphemeCategory::extendedPictographic) {
            std::size_t previous = index - 1U;
            while (previous > 0 && scalars[previous - 1U].category == GraphemeCategory::extend) {
                --previous;
            }
            if (previous > 0 &&
                scalars[previous - 1U].category == GraphemeCategory::extendedPictographic) {
                return false;
            }
        }

        if (before == GraphemeCategory::regionalIndicator &&
            after == GraphemeCategory::regionalIndicator) {
            std::size_t regionalIndicatorCount = 0;
            for (std::size_t previous = index;
                 previous > 0 &&
                 scalars[previous - 1U].category == GraphemeCategory::regionalIndicator;
                 --previous) {
                ++regionalIndicatorCount;
            }
            return regionalIndicatorCount % 2U == 0;
        }

        return true;
    }

    std::vector<std::size_t> graphemeBoundaries(std::string_view text,
                                                const std::vector<DecodedScalar>& scalars) {
        std::vector<std::size_t> boundaries;
        boundaries.reserve(scalars.size() + 1U);
        boundaries.push_back(0);
        for (std::size_t index = 1; index < scalars.size(); ++index) {
            if (isGraphemeBreak(scalars, index))
                boundaries.push_back(scalars[index].byteOffset);
        }
        if (boundaries.back() != text.size())
            boundaries.push_back(text.size());
        return boundaries;
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

core::Status PieceTable::setSelection(TextSelection selection) {
    if (!isBoundary(selection.anchor) || !isBoundary(selection.focus)) {
        return std::unexpected(
            core::error("document_selection_invalid", "The selection splits a UTF-8 code point."));
    }
    selection_ = selection;
    return {};
}

core::Result<EditResult> PieceTable::apply(const DocumentEditTransaction& transaction) {
    if (transaction.operations.empty()) {
        return EditResult{paragraphAt(selection_.focus), selection_, 0};
    }
    PieceTable candidate = *this;
    UndoEntry entry;
    entry.before = selection_;
    entry.after = transaction.selectionAfter;
    entry.origin = transaction.origin;
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
    bool coalesced = false;
    if (transaction.coalesceWithPrevious && coalescingAllowed_ && entry.operations.size() == 1 &&
        !candidate.undo_.empty()) {
        auto& previous = candidate.undo_.back();
        if (previous.origin == entry.origin && previous.operations.size() == 1 &&
            previous.after.anchor == entry.before.anchor &&
            previous.after.focus == entry.before.focus) {
            auto& previousOperation = previous.operations.front();
            const auto& operation = entry.operations.front();
            const bool previousIsInsertion =
                previousOperation.removedText.empty() && !previousOperation.insertedText.empty();
            const bool isInsertion =
                operation.removedText.empty() && !operation.insertedText.empty();
            const bool previousIsDeletion =
                previousOperation.insertedText.empty() && !previousOperation.removedText.empty();
            const bool isDeletion =
                operation.insertedText.empty() && !operation.removedText.empty();
            const bool lineBreakBoundary =
                previousOperation.insertedText.find_first_of("\r\n") != std::string::npos ||
                operation.insertedText.find_first_of("\r\n") != std::string::npos ||
                previousOperation.removedText.find_first_of("\r\n") != std::string::npos ||
                operation.removedText.find_first_of("\r\n") != std::string::npos;

            if (!lineBreakBoundary && previousIsInsertion && isInsertion &&
                previousOperation.offset + previousOperation.insertedText.size() ==
                    operation.offset) {
                previousOperation.insertedText += operation.insertedText;
                coalesced = true;
            } else if (!lineBreakBoundary && previousIsDeletion && isDeletion &&
                       operation.offset + operation.removedText.size() ==
                           previousOperation.offset) {
                previousOperation.offset = operation.offset;
                previousOperation.removedText.insert(0, operation.removedText);
                coalesced = true;
            } else if (!lineBreakBoundary && previousIsDeletion && isDeletion &&
                       operation.offset == previousOperation.offset) {
                previousOperation.removedText += operation.removedText;
                coalesced = true;
            }

            if (coalesced)
                previous.after = entry.after;
        }
    }
    if (!coalesced)
        candidate.undo_.push_back(std::move(entry));
    candidate.redo_.clear();
    candidate.coalescingAllowed_ = true;
    const auto invalidated = candidate.expandedParagraphRange(changed);
    *this = std::move(candidate);
    return EditResult{invalidated, selection_, transaction.operations.size()};
}

core::Result<EditResult> PieceTable::applyTextSnapshot(
    std::string_view updatedText, std::string documentId, std::uint64_t expectedRevision,
    std::optional<TextSelection> selectionAfter, std::string origin, bool coalesceWithPrevious) {
    if (auto status = validateUtf8(updatedText); !status)
        return std::unexpected(status.error());

    std::size_t commonPrefix = 0;
    for (const auto& piece : pieces_) {
        if (commonPrefix == updatedText.size())
            break;
        const std::string& buffer = pieceBuffer(piece);
        const std::size_t comparedLength =
            std::min(piece.length, updatedText.size() - commonPrefix);
        const auto sourceBegin = buffer.begin() + static_cast<std::ptrdiff_t>(piece.start);
        const auto sourceEnd = sourceBegin + static_cast<std::ptrdiff_t>(comparedLength);
        const auto updatedBegin = updatedText.begin() + static_cast<std::ptrdiff_t>(commonPrefix);
        const auto mismatch = std::mismatch(sourceBegin, sourceEnd, updatedBegin);
        commonPrefix += static_cast<std::size_t>(std::distance(sourceBegin, mismatch.first));
        if (mismatch.first != sourceEnd)
            break;
    }
    if (commonPrefix == size_ && size_ == updatedText.size())
        return EditResult{paragraphAt(selection_.focus), selection_, 0};
    while (commonPrefix > 0 &&
           (!isBoundary(commonPrefix) || !isUtf8Boundary(updatedText, commonPrefix))) {
        --commonPrefix;
    }

    std::size_t commonSuffix = 0;
    for (auto piece = pieces_.rbegin(); piece != pieces_.rend(); ++piece) {
        const std::size_t remainingCurrent = size_ - commonPrefix - commonSuffix;
        const std::size_t remainingUpdated = updatedText.size() - commonPrefix - commonSuffix;
        if (remainingCurrent == 0 || remainingUpdated == 0)
            break;

        const std::size_t comparedLength =
            std::min({piece->length, remainingCurrent, remainingUpdated});
        const std::string& buffer = pieceBuffer(*piece);
        const auto sourceEnd =
            buffer.begin() + static_cast<std::ptrdiff_t>(piece->start + piece->length);
        const auto sourceBegin = sourceEnd - static_cast<std::ptrdiff_t>(comparedLength);
        const auto updatedEnd =
            updatedText.begin() + static_cast<std::ptrdiff_t>(updatedText.size() - commonSuffix);
        const auto updatedBegin = updatedEnd - static_cast<std::ptrdiff_t>(comparedLength);
        const auto sourceReverseBegin = std::make_reverse_iterator(sourceEnd);
        const auto sourceReverseEnd = std::make_reverse_iterator(sourceBegin);
        const auto updatedReverseBegin = std::make_reverse_iterator(updatedEnd);
        const auto mismatch =
            std::mismatch(sourceReverseBegin, sourceReverseEnd, updatedReverseBegin);
        const std::size_t matchedLength =
            static_cast<std::size_t>(std::distance(sourceReverseBegin, mismatch.first));
        commonSuffix += matchedLength;
        if (matchedLength != comparedLength || comparedLength != piece->length)
            break;
    }

    std::size_t currentSuffix = size_ - commonSuffix;
    std::size_t updatedSuffix = updatedText.size() - commonSuffix;
    while (currentSuffix < size_ && updatedSuffix < updatedText.size() &&
           (!isBoundary(currentSuffix) || !isUtf8Boundary(updatedText, updatedSuffix))) {
        ++currentSuffix;
        ++updatedSuffix;
    }
    if (currentSuffix < commonPrefix || updatedSuffix < commonPrefix) {
        return std::unexpected(core::error(
            "document_diff_invalid", "The text snapshot did not produce valid UTF-8 edit bounds."));
    }

    const std::string removedText = slice({commonPrefix, currentSuffix});
    const std::string insertedText(updatedText.substr(commonPrefix, updatedSuffix - commonPrefix));
    DocumentEditTransaction transaction;
    transaction.documentId = std::move(documentId);
    transaction.expectedRevision = expectedRevision;
    transaction.selectionBefore = selection_;
    const std::size_t cursor = commonPrefix + insertedText.size();
    transaction.selectionAfter = selectionAfter.value_or(TextSelection{cursor, cursor});
    transaction.origin = std::move(origin);
    transaction.coalesceWithPrevious = coalesceWithPrevious;
    transaction.operations.push_back({commonPrefix, insertedText, removedText});
    return apply(transaction);
}

core::Result<EditResult> PieceTable::replace(TextRange range, std::string_view replacement,
                                             std::string documentId, std::uint64_t expectedRevision,
                                             std::string origin) {
    if (range.start > range.end || range.end > size_ || !isBoundary(range.start) ||
        !isBoundary(range.end)) {
        return std::unexpected(core::error(
            "document_range_invalid", "The edit range is outside the document or UTF-8 boundary."));
    }
    DocumentEditTransaction transaction;
    transaction.documentId = std::move(documentId);
    transaction.expectedRevision = expectedRevision;
    transaction.origin = std::move(origin);
    transaction.selectionBefore = selection_;
    transaction.selectionAfter = {range.start + replacement.size(),
                                  range.start + replacement.size()};
    transaction.operations.push_back({range.start, std::string(replacement), slice(range)});
    return apply(transaction);
}

core::Result<EditResult>
PieceTable::replaceAll(std::string_view query, std::string_view replacement, std::string documentId,
                       std::uint64_t expectedRevision, std::string origin) {
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
    transaction.documentId = std::move(documentId);
    transaction.expectedRevision = expectedRevision;
    transaction.origin = std::move(origin);
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
    coalescingAllowed_ = false;
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
    coalescingAllowed_ = false;
    selection_ = entry.after;
    result->selection = selection_;
    return result;
}

core::Result<std::size_t> PieceTable::previousCodePoint(std::size_t offset) const {
    if (offset > size_ || !isBoundary(offset)) {
        return std::unexpected(core::error(
            "document_cursor_invalid", "The cursor is outside the document or UTF-8 boundary."));
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
        return std::unexpected(core::error(
            "document_cursor_invalid", "The cursor is outside the document or UTF-8 boundary."));
    }
    if (offset == size_)
        return size_;
    ++offset;
    while (offset < size_ && isContinuationByte(byteAt(offset)))
        ++offset;
    return offset;
}

core::Result<std::size_t> PieceTable::previousGrapheme(std::size_t offset) const {
    if (offset > size_ || !isBoundary(offset)) {
        return std::unexpected(core::error(
            "document_cursor_invalid", "The cursor is outside the document or UTF-8 boundary."));
    }
    if (offset == 0)
        return 0;

    const std::string contents = text();
    const auto scalars = decodeScalars(contents);
    const auto boundaries = graphemeBoundaries(contents, scalars);
    auto boundary = std::lower_bound(boundaries.begin(), boundaries.end(), offset);
    if (boundary == boundaries.begin())
        return 0;
    --boundary;
    return *boundary;
}

core::Result<std::size_t> PieceTable::nextGrapheme(std::size_t offset) const {
    if (offset > size_ || !isBoundary(offset)) {
        return std::unexpected(core::error(
            "document_cursor_invalid", "The cursor is outside the document or UTF-8 boundary."));
    }
    if (offset == size_)
        return size_;

    const std::string contents = text();
    const auto scalars = decodeScalars(contents);
    const auto boundaries = graphemeBoundaries(contents, scalars);
    const auto boundary = std::upper_bound(boundaries.begin(), boundaries.end(), offset);
    return boundary == boundaries.end() ? size_ : *boundary;
}

std::vector<TextRange> PieceTable::findAll(std::string_view query) const {
    std::vector<TextRange> matches;
    if (query.empty())
        return matches;

    std::vector<std::size_t> prefix(query.size());
    for (std::size_t index = 1, matched = 0; index < query.size(); ++index) {
        while (matched > 0 && query[index] != query[matched])
            matched = prefix[matched - 1U];
        if (query[index] == query[matched])
            ++matched;
        prefix[index] = matched;
    }

    std::size_t matched = 0;
    std::size_t documentOffset = 0;
    for (const Piece& piece : pieces_) {
        const std::string& buffer = pieceBuffer(piece);
        for (std::size_t index = 0; index < piece.length; ++index, ++documentOffset) {
            const char character = buffer[piece.start + index];
            while (matched > 0 && character != query[matched])
                matched = prefix[matched - 1U];
            if (character == query[matched])
                ++matched;
            if (matched == query.size()) {
                const std::size_t start = documentOffset + 1U - query.size();
                const std::size_t end = documentOffset + 1U;
                if (isBoundary(start) && isBoundary(end))
                    matches.push_back({start, end});
                matched = prefix[matched - 1U];
            }
        }
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
        return std::unexpected(core::error(
            "document_range_invalid", "The edit range is outside the document or UTF-8 boundary."));
    }
    std::size_t position = 0;
    for (auto piece = pieces_.begin(); piece != pieces_.end(); ++piece) {
        const std::size_t pieceEnd = position + piece->length;
        if (offset == position || offset == pieceEnd)
            return {};
        if (offset < pieceEnd) {
            const std::size_t leftLength = offset - position;
            const Piece right{piece->buffer, piece->bufferIndex, piece->start + leftLength,
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
        return std::unexpected(core::error(
            "document_range_invalid", "The edit range is outside the document or UTF-8 boundary."));
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
