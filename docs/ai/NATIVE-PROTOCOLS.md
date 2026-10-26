> **Migration reference:** This document describes behavior, implementation, or build details from the former C++/Slint application. It remains useful as a porting specification; current TypeScript coverage is tracked in [the feature inventory](../migration/feature-inventory.md). Historical build commands are not the active TypeScript workflow.

# Native AI protocols

Tutorux has native adapters for Anthropic Messages, Google Gemini GenerateContent, OpenAI Responses,
Cohere Chat v2, the Perplexity Agent API, and Ollama. Each adapter discovers available models, stores the current catalog in
the selected `.tux` archive, streams generated text, honors request cancellation, and uses the
standard outbound package review and hash confirmation flow.

Cached catalog records retain the protocol family and metadata explicitly published by the model
list or metadata catalog: context and output limits, input and output modalities, tool and
structured-output support, streaming support, tokenizer and pricing information, freshness, and
source. Unknown fields stay `unknown`. A listed model is not treated as proof that the user's
account can access it; generation or a user-started compatibility probe is required for that check.

## Anthropic Messages

The default API base is `https://api.anthropic.com`, with `ANTHROPIC_API_KEY` read from the process
environment. Model discovery calls `GET /v1/models` and follows the provider's `after_id` cursor.
Generation calls `POST /v1/messages` with `stream: true`, the `x-api-key` header, and the required
`anthropic-version: 2023-06-01` header. The streamed `content_block_delta` text blocks are assembled
as the proposed guide response.

```text
tutorux ai models --provider anthropic --refresh
tutorux ai models --provider anthropic
tutorux ai package --session SESSION_UUID
tutorux ai generate --job PACKAGE_JOB_UUID --provider anthropic --model MODEL_ID
```

## Gemini GenerateContent

The default API base is `https://generativelanguage.googleapis.com/v1beta`, with `GEMINI_API_KEY`
read from the process environment. Model discovery calls `GET /models`, follows `nextPageToken`,
and includes models advertising `generateContent`. Generation calls the model-specific
`streamGenerateContent` endpoint, sends the key in the `x-goog-api-key` header, and reads streamed
candidate text parts.

```text
tutorux ai models --provider google-gemini --refresh
tutorux ai models --provider google-gemini
tutorux ai package --session SESSION_UUID
tutorux ai generate --job PACKAGE_JOB_UUID --provider google-gemini --model MODEL_ID
```

Both providers show the fully assembled request before sending any session data. Generation still
requires a second invocation with `--confirm-outbound --confirm-hash SHA256`, where the hash is the
serialized request body shown in the preview; keys are read from
environment variables and are never stored in provider settings. Transport failures, HTTP errors,
malformed streams, output-limit failures, and cancellation are recorded as AI job outcomes using the
same archive-backed flow as compatible providers.

## Cohere Chat v2

The default API base is `https://api.cohere.com`, with `COHERE_API_KEY` read from the process
environment. Model discovery calls `GET /v2/models?page_size=1000&endpoint=chat` and follows the
`next_page_token` cursor. Generation calls `POST /v2/chat` with a system message, a user message,
`stream: true`, and `max_tokens`. It forwards `content-delta` text and requires the terminal
`message-end` event before considering the response complete.

```text
tutorux ai models --provider cohere --refresh
tutorux ai models --provider cohere
tutorux ai package --session SESSION_UUID
tutorux ai generate --job PACKAGE_JOB_UUID --provider cohere --model MODEL_ID
```

The adapter follows the official [Cohere list-models API](https://docs.cohere.com/v2/reference/list-models)
and [streaming Chat API](https://docs.cohere.com/v2/reference/chat-stream).

## Perplexity Agent API

The default API base is `https://api.perplexity.ai/v1`, with `PERPLEXITY_API_KEY` read from the
process environment for generation. Model discovery calls the public `GET /models` endpoint.
Generation calls `POST /agent` with `instructions`, `input`, `max_output_tokens`, and `stream`.
Streaming forwards `response.output_text.delta` and accepts output only after `response.completed`.
The retired Sonar chat-completions path is not used.

```text
tutorux ai models --provider perplexity --refresh
tutorux ai models --provider perplexity
tutorux ai package --session SESSION_UUID
tutorux ai generate --job PACKAGE_JOB_UUID --provider perplexity --model MODEL_ID
```

The adapter follows Perplexity's [Agent API OpenAI compatibility and model discovery
guide](https://docs.perplexity.ai/docs/agent-api/openai-compatibility).

## OpenAI Responses

The Responses adapter sends `instructions`, `input`, `max_output_tokens`, and `stream: true` to
`POST /responses`. It forwards `response.output_text.delta` and requires `response.completed`; failed
or incomplete terminal events are recorded as unsuccessful jobs. OpenCode Zen routes its GPT, Grok,
and Muse Spark model IDs to this API family. Other OpenCode Zen models use the API family published
for that model.

```text
tutorux ai models --provider opencode-zen --refresh
tutorux ai generate --job PACKAGE_JOB_UUID --provider opencode-zen --model MODEL_ID
```

## Ollama native API

Ollama uses the local service at `http://127.0.0.1:11434` by default. Model discovery calls
`GET /api/tags`; `ai capabilities` and generation preflight call `POST /api/show` for the selected
model's completion capabilities and context length. Generation streams newline-delimited JSON from
`POST /api/chat` and requires the final `done: true` record before accepting the result. Existing
archive configurations ending in `/v1` are normalized to the Ollama service root.

```text
tutorux ai test --provider ollama
tutorux ai models --provider ollama --refresh
tutorux ai capabilities --provider ollama --model MODEL_ID
tutorux ai estimate --provider ollama --model MODEL_ID --job PACKAGE_JOB_ID
tutorux ai package --session SESSION_UUID --mode local
tutorux ai generate --job PACKAGE_JOB_ID --provider ollama --model MODEL_ID
```

The estimate uses UTF-8 byte length as a conservative prompt-size proxy because Ollama does not
expose its tokenizer through the model-details API. It reports unknown when the model omits its
context length; generation does not silently truncate a package to fit. The adapter follows the
official [model listing API](https://docs.ollama.com/api/tags), [model details API](https://docs.ollama.com/api-reference/show-model-details), and [chat API](https://docs.ollama.com/api/chat).

Provider request and response shapes follow the official [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create),
[Anthropic model listing API](https://platform.claude.com/docs/en/api/models/list),
[Gemini streaming generation API](https://ai.google.dev/api/generate-content), and
[Gemini model listing API](https://ai.google.dev/api/models).
