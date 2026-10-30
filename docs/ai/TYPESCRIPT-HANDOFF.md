# AI workspace handoff

The Solid AI workspace prepares versioned, archive-backed guide packages and can run reviewed provider requests or local GGUF models. No request is sent until the user inspects the package and confirms the exact endpoint and body hash.

## Manual packages

The `tutorux-ai-package-v1` payload includes the selected session, transcript cues, observations, evidence, asset metadata, the selected guide structure, and generation/verification instructions. Private tutor notes are excluded. When a student is linked, the package includes learning difficulties, demonstrated improvements, and progress classifications; citations are validated against archive evidence. Packages are capped at 8 MiB. The archive job stores the exact JSON bytes and matching SHA-256 values.

Users can attach up to eight session images, or PDF/audio/video materials, within the request budget. The package records asset IDs and hashes; bytes are loaded from the same session only for a reviewed request. Provider-specific content parts are generated for OpenAI, Anthropic, Gemini, and vision-capable Ollama requests.

## Providers and credentials

Provider endpoint and model settings are archive-backed for OpenAI, Anthropic, Gemini, Cohere, Perplexity, Ollama, and OpenAI-compatible services. Cloud endpoints require HTTPS; Ollama uses loopback HTTP. Provider catalogs are cached with a TTL and include capabilities, context/output limits, modalities, tokenizer/pricing metadata, and freshness. Ollama installed models can be listed and checked without exposing credentials.

API keys are stored as encrypted credential records or in the operating-system credential store. The UI requires explicit storage confirmation, never reads a key back into its display, masks values in workspace metadata, and soft-deletes credentials. Desktop keys pass directly from the native host into the reviewed provider transport without returning to Solid.

## Reviewed requests

Sending requires a second confirmation naming the endpoint and body SHA-256. The desktop bridge validates the hash and provider route, restricts cloud requests to HTTPS, limits Ollama to loopback, disables redirects and retries, sets timeouts, and bounds request and response bodies to 16 MiB. It streams response chunks without logging request bodies, credentials, or provider error bodies. Browser mode uses Fetch with redirects disabled; provider CORS rules may require the desktop app.

Requests use provider-native structured output when supported (`response_format`, Ollama `format: json`, Responses `text.format`, Gemini `responseMimeType`). Every HTTP result is retained as bounded raw bytes in an AI job with package, request, and response hashes, status, content type, completion state, provider response ID, error code/message, retry-after, and confirmation method. Partial streams and cancelled generations retain completed raw bytes and produce an unapproved draft for review. The UI never renders raw provider error bytes; they remain available for explicit export.

Saved responses can be imported from a file through the AI workspace. Imported output becomes a source-checked, unapproved guide draft and a manual AI job; malformed structure or citations fall back to editable text with correction warnings.

## Local models

The desktop host and CLI inspect and run local GGUF models without a network request. Model inspection reports architecture, training context, embedding length, layer/tensor counts, and an estimated memory upper bound. Loading refuses estimates above available system memory unless overcommit is explicitly allowed. CLI inference uses `node-llama-cpp` when a compatible runtime is installed and never downloads or builds one automatically.

## CLI

The CLI AI group supports provider configuration, context preview, reviewed generation, package export, response import, model catalogs, connection checks, job inspection/cancellation, Ollama context estimates, and embedded-model inspection. The shared context packer groups transcript gaps, splits long records at Unicode-safe boundaries, and supports injected tokenizers; the CLI uses the documented byte-based estimate by default.

Tutors must review generated claims, citations, and recommendations before approving a guide.
