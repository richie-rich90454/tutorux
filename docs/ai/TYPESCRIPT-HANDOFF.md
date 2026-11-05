# AI integration

AI in Tutorux is a native transport plus a local inference path. The old TypeScript AI packaging engine and the in-app command console are gone.

## Assistant tasks

The Assistant page supports:

- summarize a session;
- generate a study guide;
- draft student/parent feedback;
- create quiz and flashcard practice;
- plan the next lesson;
- answer a question using student context;
- extract action items.

Each task assembles local context from the selected session and/or student: notes, observations, transcript highlights, material names, goals, skills, and evidence.

## Provider registry

`frontend/api/ai.ts` registers OpenAI, Anthropic, Google Gemini, OpenRouter, DeepSeek, Groq, Mistral, xAI, Together, Fireworks, Z.AI, MiniMax, Alibaba Cloud/Qwen, Moonshot, NVIDIA, Cerebras, SambaNova, Novita, Nebius, DeepInfra, and SiliconFlow, plus local GGUF.

Provider IDs must also be accepted by `src-tauri/src/credentials.rs` and `src-tauri/src/ai_transport/validation.rs`. Adding a new provider requires all three:

1. a provider definition;
2. a credential-store allowlist entry;
3. a fixed-host/route validation entry or an OpenAI-compatible route classification.

## Cloud path

`sendAiMessage` builds the provider-specific streaming request body, hashes it, and passes a reviewed request to `send_ai_request`.

- Endpoint and body hashes must match the confirmed values.
- The endpoint must pass the provider host allowlist.
- Credentials are loaded from the OS keychain by provider ID.
- Requests and responses are bounded.
- Redirects are disabled.
- The Assistant requires an explicit confirmation checkbox before sending.

## Local GGUF path

The user selects a `.gguf` file, inspects it, loads it into the process, and then sends generation requests through `generate_embedded_text`.

- Models are never uploaded.
- Model file size and estimated memory are validated before loading.
- Local generation is streamed through a Tauri channel.
- The user must load a model before sending a local request.

## Whisper path

The bundled multilingual Whisper Base Q5_1 model runs in the desktop process. The frontend decodes the recorded audio with the Web Audio API, resamples it to 16 kHz mono WAV, and calls `transcribe_whisper`. The language selector includes the Whisper language set with automatic detection as the default.

Transcription is a review workflow: generated cues remain unverified until the user edits or marks them reviewed.

## What is not covered

- Cloud providers were not exercised with live keys in this environment.
- Local GGUF generation was not exercised with a real GGUF file in this environment.
- Real spoken-audio transcription through the UI needs a fixture.
- Provider-specific retry and streaming edge cases require provider qualification.
