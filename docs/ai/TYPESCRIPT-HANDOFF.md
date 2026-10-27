# TypeScript AI handoff

The Solid AI workspace currently ports the no-key manual guide handoff. Choose a session and a
built-in or active custom guide structure, prepare a package, inspect its complete JSON, and
explicitly confirm before saving it as an archive-backed AI job. Saved jobs can be exported as
JSON. Preparing and saving do not contact a provider.

The versioned `tutorux-ai-package-v1` payload follows the former application schema. It includes the
selected session, that session's transcript cues, observations, evidence, and asset metadata, plus
the selected guide structure and generation and verification instructions. Asset payload bytes and
private tutor notes are excluded. When a student is linked, the package includes only learning
difficulties, demonstrated improvements, and progress classifications. Each progress citation is
validated against the selected student's archive evidence; valid cross-session evidence is included
so the cited claims can be checked. Invalid citations remain labeled as failed and unverified.

Packages are capped at 8 MiB. The archive job stores the exact JSON bytes and matching SHA-256
values. Workspace loading reads AI job metadata only; the full package bytes are loaded only when
the user opens the JSON preview or exports a saved package.

The AI workspace also saves compatible provider endpoint and model settings for OpenAI, Anthropic,
Google Gemini, Cohere, Perplexity, Ollama, and custom OpenAI-compatible services. Cloud endpoints
must use HTTPS; Ollama is restricted to loopback HTTP. Configuration is archive-backed and does not
test or contact a provider. Once a package and model are ready, Tutorux can build and display the
exact text-only request body for the provider protocol, endpoint, headers, package hash, and request
body hash. Authentication values stay hidden, and preview preparation does not read a credential
or contact a provider. The current request limit is 16 MiB, with an 8 MiB package cap.

API keys can be saved as separate credential-role records only when the active archive is encrypted.
The UI requires an explicit storage confirmation, never reads the key back into its display, masks
credential values in workspace metadata, and soft-deletes a credential when removed. The key is
loaded only after the user confirms a reviewed request and is passed to one provider call; it is not
stored in the request preview, generation result, or Solid state. A system-keychain backend remains
unported.

Sending requires a second confirmation that names the exact endpoint and body SHA-256. The desktop
bridge independently checks the hash and provider route, restricts cloud requests to HTTPS, limits
Ollama to loopback HTTP, disables redirects and retries, sets connection/read/total timeouts, and
bounds request and response bodies to 16 MiB. It streams response chunks to the UI without logging
request bodies, credentials, or provider error bodies. Browser mode uses Fetch with redirects
disabled; provider CORS rules may prevent cross-origin requests, so the desktop app is the supported
native path.

Every response with an HTTP result is retained as bounded raw bytes in an archive AI job with
package, request, and response hashes, HTTP status, content type, completion state, and confirmation
method. This includes provider errors, unsupported formats, decode failures, and the received prefix
of a stream that fails or exceeds the 16 MiB cap. The UI never renders raw provider error bytes;
they remain available for explicit export. The provider stream is decoded for OpenAI Chat
Completions, Anthropic Messages, Gemini, Cohere, Perplexity Agent, and Ollama. Tutorux converts
structured output into a source-checked, unapproved guide draft; malformed output is kept as editable
text, and off-session citations are removed from the draft and marked for correction. Tutors must
review generated claims, citations, and recommendations before approving a guide. Asset bytes are
still excluded from provider requests, and the CLI AI command group and embedded local-model runtime
remain unported.
