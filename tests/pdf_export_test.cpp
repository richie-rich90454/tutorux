#include "tutorux/document/pdf_export.hpp"

#include <podofo/podofo.h>

#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>

namespace {

    int reportFailure(std::string_view step, std::string_view detail) {
        std::cerr << step << ": " << detail << '\n';
        return 1;
    }

    tutorux::domain::GuideDocument sampleGuide() {
        using namespace tutorux;
        domain::GuideDocument guide;
        guide.id = archive::randomUuid();
        guide.sessionId = archive::uuidToString(archive::randomUuid());
        guide.title = "Learning Guide | 数学复习";
        guide.templateId = "exam-review";
        guide.approvalState = "approved";
        guide.sections.push_back({"section-1",
                                  "Learning goals",
                                  {{"paragraph",
                                    "Review the core ideas and explain "
                                    "why each step is valid.",
                                    {}}}});
        guide.sections.push_back(
            {"section-2",
             "练习与反思",
             {{"quote", "先观察规律，再验证结论。", {"source-1"}},
              {"list-item", "Show each step and check the result.", {"source-2"}}}});
        for (unsigned index = 0; index < 70; ++index) {
            guide.sections.back().blocks.push_back(
                {"paragraph",
                 "Use a worked example, explain the reasoning in complete sentences, and connect "
                 "the final answer to the evidence. 这是一个用于验证换行和字体嵌入的中文段落。",
                 {"source-" + std::to_string(index + 3)}});
        }
        return guide;
    }

} // namespace

int main(int argc, char** argv) {
    const auto guide = sampleGuide();
    auto rendered = tutorux::document::renderGuidePdf(guide);
    if (!rendered)
        return reportFailure("render PDF", rendered.error().message);
    if (!rendered->starts_with("%PDF-") || rendered->find("%%EOF") == std::string::npos)
        return reportFailure("PDF framing", "Rendered bytes are not a complete PDF document.");

    try {
        PoDoFo::PdfMemDocument parsed;
        parsed.LoadFromBuffer(PoDoFo::bufferview(rendered->data(), rendered->size()));
        if (parsed.GetPages().GetCount() < 2)
            return reportFailure("pagination", "Long guide did not flow onto multiple pages.");
        const auto& metadata = parsed.GetMetadata();
        const auto title = metadata.GetTitle();
        if (!title.has_value() || title->GetString() != guide.title)
            return reportFailure("document metadata", "Guide title metadata was not preserved.");
    } catch (const std::exception& exception) {
        return reportFailure("PDF parse", exception.what());
    }

    if (argc > 1) {
        const std::filesystem::path outputPath(argv[1]);
        std::filesystem::create_directories(outputPath.parent_path());
        std::ofstream output(outputPath, std::ios::binary | std::ios::trunc);
        output.write(rendered->data(), static_cast<std::streamsize>(rendered->size()));
        if (!output)
            return reportFailure("sample output",
                                 "Could not write rendered PDF for visual review.");
    }
    return 0;
}
