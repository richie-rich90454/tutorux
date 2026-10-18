# OpenAI-compatible providers

Tutorux supports model discovery and streamed chat completions for OpenAI, OpenRouter, Groq,
DeepSeek, Mistral, Together AI, Fireworks AI, xAI, Cerebras, SambaNova, NVIDIA NIM, DeepInfra,
Moonshot AI, Novita, Nebius AI Studio, SiliconFlow, MiniMax, Alibaba Cloud Model Studio, Baidu
Qianfan, Tencent Cloud TokenHub, Volcengine Ark, Amazon Bedrock Mantle, Azure OpenAI,
Cloudflare Workers AI, AI21, Z.AI, Hugging Face Inference Providers, and user-configured providers
that implement the OpenAI `/models` and `/chat/completions` endpoints. AI21 and Z.AI use their
OpenAI-compatible chat APIs with a dynamic models.dev catalog fallback. Ollama uses its native API;
LM Studio and llama.cpp server use
OpenAI-compatible APIs. Other listed providers remain integration targets.

Configure an endpoint and an optional default model in the selected archive:

```text
tutorux ai configure --provider openai --model MODEL_ID
tutorux ai configure --provider openrouter --model MODEL_ID
tutorux ai configure --provider groq --model MODEL_ID
tutorux ai configure --provider deepseek --model MODEL_ID
tutorux ai configure --provider mistral --model MODEL_ID
tutorux ai configure --provider together --model MODEL_ID
tutorux ai configure --provider fireworks --model MODEL_ID
tutorux ai configure --provider xai --model MODEL_ID
tutorux ai configure --provider cerebras --model MODEL_ID
tutorux ai configure --provider sambanova --model MODEL_ID
tutorux ai configure --provider nvidia --model MODEL_ID
tutorux ai configure --provider deepinfra --model MODEL_ID
tutorux ai configure --provider moonshot --model MODEL_ID
tutorux ai configure --provider novita --model MODEL_ID
tutorux ai configure --provider nebius --model MODEL_ID
tutorux ai configure --provider siliconflow --model MODEL_ID
tutorux ai configure --provider minimax --model MODEL_ID
tutorux ai configure --provider alibaba-cloud --model MODEL_ID
tutorux ai configure --provider baidu --model MODEL_ID
tutorux ai configure --provider tencent-cloud --model MODEL_ID
tutorux ai configure --provider volcengine --model MODEL_ID
tutorux ai configure --provider bedrock --model MODEL_ID
tutorux ai configure --provider azure-openai --endpoint https://RESOURCE.openai.azure.com/openai/v1 \
  --model DEPLOYMENT_ID
tutorux ai configure --provider huggingface --model MODEL_ID:fastest
tutorux ai configure --provider cloudflare-workers-ai \
  --endpoint https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1 --model MODEL_ID
tutorux ai configure --provider ai21 --model MODEL_ID
tutorux ai configure --provider zai --model MODEL_ID
tutorux ai configure --provider opencode-go --model MODEL_ID
tutorux ai configure --provider openai-compatible --endpoint https://provider.example/v1 \
  --model MODEL_ID
tutorux ai configure --provider ollama --model LOCAL_MODEL_ID
tutorux ai configure --provider lm-studio --model LOCAL_MODEL_ID
tutorux ai configure --provider llama.cpp-server --model LOCAL_MODEL_ID
```

Built-in provider defaults and environment variables are:

| Provider | API endpoint | Default API-key environment variable |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| DeepSeek | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| Mistral | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |
| Together AI | `https://api.together.ai/v1` | `TOGETHER_API_KEY` |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` |
| xAI | `https://api.x.ai/v1` | `XAI_API_KEY` |
| Cerebras | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` |
| SambaNova | `https://api.sambanova.ai/v1` | `SAMBANOVA_API_KEY` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` |
| DeepInfra | `https://api.deepinfra.com/v1/openai` | `DEEPINFRA_API_KEY` |
| Moonshot AI | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` |
| Novita AI | `https://api.novita.ai/openai/v1` | `NOVITA_API_KEY` |
| Nebius AI Studio | `https://api.studio.nebius.com/v1` | `NEBIUS_API_KEY` |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `SILICONFLOW_API_KEY` |
| MiniMax | `https://api.minimax.io/v1` | `MINIMAX_API_KEY` |
| Alibaba Cloud Model Studio | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` |
| Baidu Qianfan | `https://qianfan.baidubce.com/v2` | `BAIDU_API_KEY` |
| Tencent Cloud TokenHub | `https://tokenhub.tencentmaas.com/v1` | `TOKENHUB_API_KEY` |
| Volcengine Ark | `https://ark.cn-beijing.volces.com/api/v3` | `ARK_API_KEY` |
| Amazon Bedrock Mantle | `https://bedrock-mantle.us-east-1.api.aws/v1` | `AWS_BEARER_TOKEN_BEDROCK` |
| Azure OpenAI | Configure the resource `/openai/v1` URL | `AZURE_OPENAI_API_KEY` |
| Hugging Face Inference Providers | `https://router.huggingface.co/v1` | `HF_TOKEN` |
| Cloudflare Workers AI | Account-scoped `/accounts/ACCOUNT_ID/ai/v1` endpoint | `CLOUDFLARE_API_TOKEN` |
| AI21 | `https://api.ai21.com/studio/v1` | `AI21_API_KEY` |
| Z.AI | `https://api.z.ai/api/paas/v4` | `ZAI_API_KEY` |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | `OPENCODE_GO_API_KEY` |
| OpenCode Zen | `https://opencode.ai/inference/v1` | `OPENCODE_API_KEY` |
| Replicate | `https://api.replicate.com/v1` | `REPLICATE_API_TOKEN` |

The cloud endpoints use each provider's documented OpenAI-compatible model-list and chat-completion
routes: [OpenRouter](https://openrouter.ai/docs/api/api-reference/models/get-models),
[Baidu Qianfan](https://cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y),
[Tencent Cloud TokenHub](https://cloud.tencent.com/document/product/1823/130078),
[Volcengine Ark](https://docs.volcengine.com/docs/ark/compatible-with-openai-sdk?lang=zh),
[Groq](https://console.groq.com/docs/api-reference),
[DeepSeek model listing](https://api-docs.deepseek.com/api/list-models/) and
[chat completions](https://api-docs.deepseek.com/api/create-chat-completion/),
[Mistral](https://docs.mistral.ai/api),
[Fireworks AI's OpenAI drop-in inference API](https://docs.fireworks.ai/),
[Together AI model listing](https://docs.together.ai/reference/models) and
[chat completions](https://docs.together.ai/reference/chat-completions),
[xAI model listing](https://docs.x.ai/developers/rest-api-reference/inference/models) and
[chat completions](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions), and
[Cerebras model listing](https://inference-docs.cerebras.ai/api-reference/models/list-models) and
[chat completions](https://inference-docs.cerebras.ai/api-reference/chat-completions),
[SambaNova model listing](https://docs-prod.sambanova.ai/docs/api-reference/endpoints/model-list)
and its OpenAI-compatible chat endpoint, [NVIDIA NIM chat APIs](https://docs.api.nvidia.com/nim/reference/llm-apis),
[DeepInfra's OpenAI-compatible API](https://github.com/deepinfra/docs/blob/main/api-reference/introduction.mdx),
and [Moonshot's OpenAI-compatible API and model listing](https://platform.kimi.ai/docs/api/overview).
[Novita model listing](https://docs.novita.ai/api-reference/model-apis-llm-list-models) and
[chat completions](https://docs.novita.ai/api-reference/model-apis-llm-create-chat-completion),
[Nebius AI Studio's OpenAI-compatible inference API](https://api.studio.nebius.com/docs),
[SiliconFlow model listing](https://siliconflow.readme.io/reference/retrieve-a-list-of-models) and
[OpenAI-compatible chat quickstart](https://api-docs.siliconflow.cn/docs/userguide/quickstart),
and [MiniMax model listing](https://platform.minimax.io/docs/api-reference/models/openai/list-models)
and [chat completions](https://platform.minimax.io/docs/api-reference/text-chat-openai).
Hugging Face Inference Providers exposes OpenAI-compatible chat completions and a dynamic `/models`
catalog through its inference router; selected provider routing can be expressed as a model suffix.
See the official [chat completion API](https://huggingface.co/docs/inference-providers/en/tasks/chat-completion)
and [router model catalog](https://huggingface.co/docs/inference-providers/main/hub-api).
Cloudflare Workers AI uses the account-specific OpenAI-compatible chat endpoint for generation and
the account-scoped Model Search API for discovery. Search results are paginated and hide
experimental models. Configure the account `/ai/v1` base URL. See Cloudflare's official
[OpenAI-compatible endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)
and [Model Search API](https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/).
AI21 Jamba and Z.AI use streamed OpenAI-compatible chat completions. Their provider APIs do not
expose the model-list route used by this adapter, so Tutorux fetches model IDs from the public
models.dev catalog and stores them in the selected archive. `ai test` reports the catalog result
only; it does not claim that the account key or model access works. The normal outbound preview and
package hash confirmation still apply to generation. See AI21's [official SDK and chat examples](https://github.com/AI21Labs/ai21-typescript),
Z.AI's [developer documentation](https://docs.z.ai/guides/capabilities/mcp-call), and the
[models.dev catalog API](https://github.com/anomalyco/models.dev).
OpenCode Go model discovery uses its `/models` endpoint. Its current terms describe use for
coding-agent traffic and require a stable session identifier and client identity on generation
traffic. Tutorux can inspect the model catalog, but blocks sending tutoring packages, notes, or
transcripts to this provider. See the official [OpenCode Go usage conditions and endpoints](https://docs.opencode.ai/docs/go/).
OpenCode Zen lists models from `/inference/v1/models`; its model table assigns different inference
families. Tutorux routes GPT, Grok, and Muse Spark models through OpenAI Responses; Claude and
supported Qwen models through Anthropic Messages; Gemini models through GenerateContent; and the
remaining text models through OpenAI Chat Completions. Jev models are rejected because they return
typed classifications instead of guide text. The API family is saved with each cached model.
See OpenCode's official [model endpoint table](https://docs.opencode.ai/docs/zen/) and
[inference API](https://dev.opencode.ai/v2/docs/console/api/inference/).
Replicate model discovery searches for text-related results and stores a bounded catalog. Before
generation, Tutorux inspects the selected model's latest input schema and proceeds only when it has
a string `prompt` input and no unsupported required inputs or required author secrets. The
prediction request is shown in the normal outbound preview; Tutorux polls the prediction API and
accepts plain-text results only. Models that return files or structured objects are rejected. See
Replicate's official [model search and predictions API](https://replicate.com/docs/reference/http/)
and [model input schemas](https://replicate.com/docs/reference/openapi/).
Alibaba generation uses a regional OpenAI-compatible endpoint. Tutorux discovers text-generation
models through the provider's regional `/api/v1/models` endpoint with `capabilities=TG` and follows
`page_no`/`page_size` pagination. Use an API key and endpoint from the same region. See the official
[endpoint overview](https://help.aliyun.com/en/model-studio/base-url),
[model-list API](https://help.aliyun.com/en/model-studio/list-models), and
[OpenAI-compatible chat API](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions).
Baidu Qianfan, Tencent Cloud TokenHub, and Volcengine Ark use their documented OpenAI-compatible
model-list and streamed chat-completion endpoints. The configured region, account permissions,
deployment access, and selected model still determine whether a request succeeds. See the official
[Qianfan model list](https://cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y) and
[OpenAI-compatible chat guide](https://intl.cloud.baidu.com/en/doc/qianfan/s/qm8qxemze-intl-en),
[TokenHub model list and API usage](https://cloud.tencent.com/document/product/1823/130078), and
[Volcengine OpenAI SDK compatibility guide](https://docs.volcengine.com/docs/ark/compatible-with-openai-sdk?lang=zh).
Bedrock uses its `bedrock-mantle` OpenAI-compatible `/models` and `/chat/completions` routes with a
Bedrock API key. Configure a different regional endpoint when needed. Bedrock's `bedrock-runtime`
endpoint does not expose the OpenAI `/models` route, so it cannot be used for this adapter. See the
official [Bedrock Chat Completions API](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html)
and [model listing guidance](https://docs.aws.amazon.com/bedrock/latest/userguide/models-get-info.html).
Azure OpenAI uses the v1 models and chat-completions API. Set the endpoint to the resource's
`/openai/v1` base URL and use the deployment name as the model ID; Tutorux sends the key in the
`api-key` header. See Microsoft's [models API](https://learn.microsoft.com/en-us/rest/api/aifoundry/azureopenai/models)
and [chat API](https://learn.microsoft.com/en-us/rest/api/aifoundry/azureopenai/chat).
xAI's Chat
Completions API is a legacy route; Tutorux currently uses it because the shared adapter supports
streamed chat completions, while xAI recommends its Responses API for newer features. Tutorux sends
common chat-completion fields only; provider-specific generation features are not inferred. Catalog
metadata is recorded only when the provider explicitly publishes it, and is not taken as proof that
the account can access a model. A provider may reject a model or request that it does not support. Automated compatibility
tests use loopback protocol fixtures to check request paths, credentials, request bodies, consent
gates, and response handling; they do not send requests using live provider accounts or prove that
a particular model is available to an account.

Provider keys are read from the process environment and are not persisted by `ai generate`; literal
command-line values are rejected. The default environment variable can be overridden with
`--api-key-env`:

```powershell
$env:OPENAI_API_KEY = "..."
tutorux ai models --provider openai --refresh --api-key-env OPENAI_API_KEY
tutorux ai models --provider openai
$env:OPENROUTER_API_KEY = "..."
tutorux ai models --provider openrouter --refresh
tutorux ai models --provider openrouter
$env:GROQ_API_KEY = "..."
tutorux ai models --provider groq --refresh
$env:DEEPSEEK_API_KEY = "..."
tutorux ai models --provider deepseek --refresh
$env:MISTRAL_API_KEY = "..."
tutorux ai models --provider mistral --refresh
$env:TOGETHER_API_KEY = "..."
tutorux ai models --provider together --refresh
$env:XAI_API_KEY = "..."
tutorux ai models --provider xai --refresh
$env:CEREBRAS_API_KEY = "..."
tutorux ai models --provider cerebras --refresh
$env:FIREWORKS_API_KEY = "..."
tutorux ai models --provider fireworks --refresh
$env:BAIDU_API_KEY = "..."
tutorux ai models --provider baidu --refresh
$env:TOKENHUB_API_KEY = "..."
tutorux ai models --provider tencent-cloud --refresh
$env:ARK_API_KEY = "..."
tutorux ai models --provider volcengine --refresh
$env:CLOUDFLARE_API_TOKEN = "..."
tutorux ai models --provider cloudflare-workers-ai --refresh
$env:AI21_API_KEY = "..."
tutorux ai models --provider ai21 --refresh
$env:ZAI_API_KEY = "..."
tutorux ai models --provider zai --refresh
$env:OPENCODE_GO_API_KEY = "..."
tutorux ai models --provider opencode-go --refresh
```

Model refresh makes an authenticated HTTPS request and caches model IDs, owners, capability
metadata, and catalog freshness in the selected archive. Catalog metadata is considered fresh for
one hour. `ai models --provider ID --refresh-if-stale` refreshes only when the cached catalog is
missing or older than that TTL; `--refresh` always requests a refresh. A normal `ai models` command
reads the cached catalog without connecting and reports its freshness, age, source, and last
successful check time. JSON output retains its array shape and includes the same catalog freshness
fields on each model row.

If a provider's model endpoint is unavailable, Tutorux tries the matching public catalog at
[models.dev](https://models.dev) for supported providers. Such rows are labeled
`models.dev-fallback` and remain metadata discoveries, not account-level verification. If both
sources are unavailable, Tutorux uses the last archived catalog when one exists and reports the
failed refresh while preserving its original successful-check timestamp. It returns an error when
no cached catalog exists. Cancellation, authentication failures, invalid endpoints, and local
providers never fall through to public catalog discovery. A catalog fallback does not make or alter
generation requests.

Idempotent HTTP `GET` metadata requests retry transient transport failures and HTTP 408, 425, 429,
500, 502, 503, and 504 responses at most twice. The transport honors a usable `Retry-After` value
and otherwise uses short bounded backoff; it stops rather than retrying earlier than a longer
server-requested delay. Cancellation interrupts the backoff. Generation uses `POST` and is never
automatically retried, so a transient provider error cannot duplicate generated work.

The `ai test` command checks connectivity by fetching a fresh provider model catalog without changing
the archived catalog.
Loopback HTTP endpoints
are allowed for local development; remote requests require HTTPS, certificate verification, and do
not follow redirects. On Windows, certificate verification also loads the operating system's native
root store, so the portable package does not depend on an MSYS2 CA bundle path.

Create a JSON package to prepare a request:

```text
tutorux ai package --session SESSION_UUID --format json
tutorux ai generate --job PACKAGE_JOB_UUID --provider openai --model MODEL_ID \
  --api-key-env OPENAI_API_KEY
```

The first `ai generate` call sends nothing. It displays the endpoint, complete JSON request body,
package SHA-256, and exact request-body SHA-256. Supported image, audio, video, and PDF assets are
read from the archive and included only when the selected model's discovered capabilities and
protocol accept them. Review the request before repeating the command with
`--confirm-outbound --confirm-hash SHA256`. Tutorux checks the hash of the exact request body,
including attached asset bytes, before resolving the API key or opening a connection. Use the
displayed request-body SHA-256 for confirmation.
Packages larger than 8 MiB are rejected before request construction; no source content is silently
truncated. The HTTP transport also rejects bodies over 16 MiB before opening a connection.

Tutorux streams response text to the caller's progress callback and retains the exact provider
response bytes in an archive AI job. Valid guide JSON becomes a new proposed guide; unsupported
responses are retained as plain text for correction. Partial output is retained on cancellation or
stream failure. Every resulting guide remains proposed and requires tutor review before approval.
Generation POST errors do not trigger automatic retries.

The archive supports separate, explicit credential storage for users who choose to save a sensitive
setting inside an encrypted `.tux` file. The OpenAI-compatible adapter currently reads environment
variables only and does not consume those saved credentials. OpenAI requests use
`max_completion_tokens`; generic OpenAI-compatible requests use `max_tokens`.

## Local model servers

Tutorux supports Ollama through its native API and LM Studio and llama.cpp server through their
OpenAI-compatible endpoints. The defaults are `http://127.0.0.1:11434` for Ollama,
`http://127.0.0.1:1234/v1` for LM Studio, and `http://127.0.0.1:8080/v1` for llama.cpp server.
Every configured local endpoint must be loopback HTTP (`localhost`, `127.0.0.1`, or `::1`); remote
endpoints are rejected before a request is made. Ollama discovery uses `/api/tags`, metadata
inspection uses `/api/show`, and streamed generation uses `/api/chat` with NDJSON. LM Studio and
llama.cpp discovery use `/v1/models` and generation uses streamed `/v1/chat/completions`. These
local operations do not read or persist an API key.

```text
tutorux ai models --provider ollama --refresh
tutorux ai models --provider ollama
tutorux ai package --session SESSION_UUID --mode local
tutorux ai generate --job LOCAL_PACKAGE_JOB_UUID --provider ollama --model LOCAL_MODEL_ID
tutorux ai models --provider lm-studio --refresh
tutorux ai models --provider llama.cpp-server --refresh
```

The package and result stay in the selected archive. The generated job records a
`loopback-only` processing boundary and has no cloud outbound-consent fields. The model and Ollama
or other local inference service remain user-provisioned; Tutorux does not download weights, start
the service, or modify its configuration. The local provider routes follow the upstream
[Ollama compatibility reference](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx),
[LM Studio compatibility endpoints](https://lmstudio.ai/docs/developer/openai-compat), and
[llama.cpp server reference](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
