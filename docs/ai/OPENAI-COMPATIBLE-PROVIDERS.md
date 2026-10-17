# OpenAI-compatible providers

Tutorux supports model discovery and streamed chat completions for OpenAI, OpenRouter, Groq,
DeepSeek, Mistral, Together AI, xAI, Cerebras, SambaNova, NVIDIA NIM, DeepInfra, Moonshot AI,
Novita, Nebius AI Studio, SiliconFlow, MiniMax, Alibaba Cloud Model Studio, Hugging Face Inference
Providers, and user-configured providers that implement the OpenAI `/models` and `/chat/completions`
endpoints. Ollama, LM Studio, and llama.cpp server are
supported as local providers through their OpenAI-compatible APIs. Other listed providers remain
integration targets.

Configure an endpoint and an optional default model in the selected archive:

```text
tutorux ai configure --provider openai --model MODEL_ID
tutorux ai configure --provider openrouter --model MODEL_ID
tutorux ai configure --provider groq --model MODEL_ID
tutorux ai configure --provider deepseek --model MODEL_ID
tutorux ai configure --provider mistral --model MODEL_ID
tutorux ai configure --provider together --model MODEL_ID
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
tutorux ai configure --provider huggingface --model MODEL_ID:fastest
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
| Hugging Face Inference Providers | `https://router.huggingface.co/v1` | `HF_TOKEN` |

The cloud endpoints use each provider's documented OpenAI-compatible model-list and chat-completion
routes: [OpenRouter](https://openrouter.ai/docs/api/api-reference/models/get-models),
[Groq](https://console.groq.com/docs/api-reference),
[DeepSeek model listing](https://api-docs.deepseek.com/api/list-models/) and
[chat completions](https://api-docs.deepseek.com/api/create-chat-completion/),
[Mistral](https://docs.mistral.ai/api),
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
Alibaba generation uses a regional OpenAI-compatible endpoint. Tutorux discovers text-generation
models through the provider's regional `/api/v1/models` endpoint with `capabilities=TG` and follows
`page_no`/`page_size` pagination. Use an API key and endpoint from the same region. See the official
[endpoint overview](https://help.aliyun.com/en/model-studio/base-url),
[model-list API](https://help.aliyun.com/en/model-studio/list-models), and
[OpenAI-compatible chat API](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions).
xAI's Chat
Completions API is a legacy route; Tutorux currently uses it because the shared adapter supports
streamed chat completions, while xAI recommends its Responses API for newer features. Tutorux sends
common chat-completion fields only; provider-specific features and model capabilities are not
inferred. A provider may reject a model or request that it does not support. Automated compatibility
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
```

Model refresh makes one authenticated HTTPS request and caches model IDs and owners in the selected
archive. A normal `ai models` command reads that cache without connecting. Loopback HTTP endpoints
are allowed for local development; remote requests require HTTPS, certificate verification, and do
not follow redirects. On Windows, certificate verification also loads the operating system's native
root store, so the portable package does not depend on an MSYS2 CA bundle path.

Create a JSON package to prepare a request:

```text
tutorux ai package --session SESSION_UUID --format json
tutorux ai generate --job PACKAGE_JOB_UUID --provider openai --model MODEL_ID \
  --api-key-env OPENAI_API_KEY
```

The first `ai generate` call sends nothing. It displays the endpoint and the complete JSON request
body, including the prompt and every package record, plus the package SHA-256. Review that content
before repeating the command with `--confirm-outbound --confirm-hash SHA256`. Tutorux checks the
hash against both the package's stored hash and its current bytes before resolving the API key or
opening a connection. Use the same command options and the displayed package hash for confirmation.
Packages larger than 8 MiB are rejected before request construction; no source content is silently
truncated. The HTTP transport also rejects bodies over 16 MiB before opening a connection.

Tutorux streams response text to the caller's progress callback and retains the exact provider
response bytes in an archive AI job. Valid guide JSON becomes a new proposed guide; unsupported
responses are retained as plain text for correction. Partial output is retained on cancellation or
stream failure. Every resulting guide remains proposed and requires tutor review before approval.
Provider errors do not trigger automatic retries.

The archive supports separate, explicit credential storage for users who choose to save a sensitive
setting inside an encrypted `.tux` file. The OpenAI-compatible adapter currently reads environment
variables only and does not consume those saved credentials. OpenAI requests use
`max_completion_tokens`; generic OpenAI-compatible requests use `max_tokens`.

## Local model servers

Tutorux supports existing Ollama, LM Studio, and llama.cpp server instances through their
OpenAI-compatible endpoints. The defaults are `http://127.0.0.1:11434/v1` for Ollama,
`http://127.0.0.1:1234/v1` for LM Studio, and `http://127.0.0.1:8080/v1` for llama.cpp server.
Every configured local endpoint must be loopback HTTP (`localhost`, `127.0.0.1`, or `::1`); remote
endpoints are rejected before a request is made. Discovery uses `/v1/models`, and generation uses
streamed `/v1/chat/completions`. These local operations do not read or persist an API key.

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
