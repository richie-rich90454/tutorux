#include "tutorux/document/pdf_export.hpp"

#include <span>
#include <string>

namespace tutorux::document {

core::Result<std::string> renderGuidePdf(const domain::GuideDocument&,
                                         std::span<const GuideImageAsset>) {
    return std::unexpected(core::error(
        "pdf_unavailable",
        "PDF export is not compiled into this profile. Use the full build or export DOCX."));
}

} // namespace tutorux::document
