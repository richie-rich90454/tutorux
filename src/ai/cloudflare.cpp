#include "tutorux/ai/cloudflare.hpp"

#include "tutorux/ai/http.hpp"
#include "tutorux/command/json.hpp"

#include <chrono>
#include <cstddef>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>
#include <variant>

namespace tutorux::ai {
namespace {

    constexpr std::size_t maximumModels = 10'000;
    constexpr std::size_t modelsPerPage = 100;
    constexpr std::size_t maximumPages = maximumModels / modelsPerPage;

    const command::JsonValue* member(const command::JsonValue::Object& object,
                                     std::string_view key) {
        const auto found = object.find(key);
        return found == object.end() ? nullptr : &found->second;
    }

    std::string stringField(const command::JsonValue::Object& object, std::string_view key) {
        const auto* value = member(object, key);
        const auto* text = value ? value->asString() : nullptr;
        return text ? *text : std::string{};
    }

    core::Result<std::string> modelSearchUrl(std::string_view endpoint) {
        while (!endpoint.empty() && endpoint.back() == '/')
            endpoint.remove_suffix(1);
        constexpr std::string_view expectedOrigin =
            "https://api.cloudflare.com/client/v4/accounts/";
        constexpr std::string_view expectedSuffix = "/ai/v1";
        if (!endpoint.starts_with(expectedOrigin) || !endpoint.ends_with(expectedSuffix) ||
            endpoint.find_first_of("?#\r\n") != std::string_view::npos) {
            return std::unexpected(core::error(
                "ai_provider_endpoint_invalid",
                "Cloudflare Workers AI requires an account-scoped HTTPS endpoint ending in "
                "'/ai/v1'."));
        }

        const std::string_view accountId =
            endpoint.substr(expectedOrigin.size(),
                            endpoint.size() - expectedOrigin.size() - expectedSuffix.size());
        if (accountId.empty() || accountId.find('/') != std::string_view::npos ||
            accountId.find_first_not_of("0123456789abcdefABCDEF-") != std::string_view::npos) {
            return std::unexpected(core::error(
                "ai_provider_endpoint_invalid",
                "The Cloudflare account-scoped endpoint contains an invalid account ID."));
        }

        return std::string(expectedOrigin) + std::string(accountId) + "/ai/models/search";
    }

    core::Result<std::vector<ProviderModel>> parseModelPage(std::string_view body) {
        auto parsed = command::parseJson(body, 32, 200'000, 16U * 1024U * 1024U);
        if (!parsed) {
            return std::unexpected(core::error("ai_model_catalog_invalid",
                                               "Cloudflare returned an invalid model catalog."));
        }
        const auto* root = parsed->asObject();
        const auto* resultValue = root ? member(*root, "result") : nullptr;
        const auto* entries = resultValue ? resultValue->asArray() : nullptr;
        if (!root || !entries || entries->size() > modelsPerPage) {
            return std::unexpected(
                core::error("ai_model_catalog_invalid",
                            "Cloudflare returned an invalid model catalog page."));
        }
        if (const auto* success = member(*root, "success");
            success && std::holds_alternative<bool>(success->value) &&
            !std::get<bool>(success->value)) {
            return std::unexpected(core::error("ai_model_catalog_invalid",
                                               "Cloudflare rejected the model search request."));
        }

        std::vector<ProviderModel> models;
        models.reserve(entries->size());
        for (const auto& entry : *entries) {
            const auto* model = entry.asObject();
            if (!model) {
                return std::unexpected(
                    core::error("ai_model_catalog_invalid",
                                "Cloudflare returned a model entry with an invalid shape."));
            }
            std::string id = stringField(*model, "name");
            if (id.empty())
                id = stringField(*model, "id");
            if (id.empty() || id.size() > 1024) {
                return std::unexpected(core::error("ai_model_catalog_invalid",
                                                   "Cloudflare returned a model without a name."));
            }
            std::string owner = stringField(*model, "author");
            if (owner.empty())
                owner = stringField(*model, "provider");
            if (owner.empty())
                owner = stringField(*model, "owned_by");
            models.push_back({std::move(id), std::move(owner)});
        }
        return models;
    }

    core::Error cloudflareHttpError(const HttpResponse& response) {
        if (response.cancelled)
            return core::error("operation_cancelled", "The Cloudflare request was cancelled.");
        if (response.responseTooLarge)
            return core::error("ai_response_too_large",
                               "The Cloudflare model catalog exceeded the response limit.");
        if (!response.transportError.empty())
            return core::error("ai_network_error", response.transportError);
        if (response.statusCode == 401 || response.statusCode == 403)
            return core::error("ai_authentication_failed",
                               "Cloudflare rejected the API token or its Workers AI access.");
        return core::error("ai_provider_http_error",
                           "Cloudflare model discovery returned HTTP " +
                               std::to_string(response.statusCode) + ".");
    }

} // namespace

core::Result<std::vector<ProviderModel>>
listCloudflareWorkersAiModels(std::string_view compatibleEndpoint,
                              std::string_view apiToken,
                              std::function<bool()> cancelled) {
    if (apiToken.empty()) {
        return std::unexpected(
            core::error("ai_api_key_missing", "Set CLOUDFLARE_API_TOKEN before model discovery."));
    }
    auto baseUrl = modelSearchUrl(compatibleEndpoint);
    if (!baseUrl)
        return std::unexpected(baseUrl.error());

    std::vector<ProviderModel> models;
    models.reserve(512);
    std::unordered_set<std::string> seenIds;
    seenIds.reserve(512);
    for (std::size_t page = 1; page <= maximumPages; ++page) {
        if (cancelled && cancelled()) {
            return std::unexpected(
                core::error("operation_cancelled", "Cloudflare model discovery was cancelled."));
        }
        HttpRequest request;
        request.url = *baseUrl +
                      "?hide_experimental=true&per_page=" + std::to_string(modelsPerPage) +
                      "&page=" + std::to_string(page);
        request.headers.emplace_back("Authorization", "Bearer " + std::string(apiToken));
        request.maximumResponseBytes = 16U * 1024U * 1024U;
        request.timeout = std::chrono::seconds(30);
        request.cancelled = cancelled;
        auto response = performHttp(std::move(request));
        if (!response)
            return std::unexpected(response.error());
        if (response->statusCode < 200 || response->statusCode >= 300 || response->cancelled ||
            response->responseTooLarge || !response->transportError.empty()) {
            return std::unexpected(cloudflareHttpError(*response));
        }

        auto pageModels = parseModelPage(response->body);
        if (!pageModels)
            return std::unexpected(pageModels.error());
        const std::size_t pageSize = pageModels->size();
        for (auto& model : *pageModels) {
            if (seenIds.insert(model.id).second)
                models.push_back(std::move(model));
        }
        if (pageSize < modelsPerPage)
            return models;
        if (models.size() >= maximumModels)
            break;
    }

    if (models.empty()) {
        return std::unexpected(
            core::error("ai_model_catalog_invalid",
                        "Cloudflare returned no discoverable Workers AI models."));
    }
    return models;
}

} // namespace tutorux::ai
