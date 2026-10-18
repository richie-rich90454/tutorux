# Multimodal AI input

Tutorux uses one typed generation-content representation for text, images, audio, documents, and
video. Provider adapters serialize those parts into their native request formats; an adapter never
silently drops binary content.

## Asset handling

An AI package records the asset IDs, MIME types, and content hashes. At generation time Tutorux
reopens each supported asset from the active archive, verifies its content hash and byte count, and
attaches its bytes to the request. The stored AI package remains small and does not duplicate asset
blobs.

Current binary input support is:

| Provider protocol | Supported binary input |
| --- | --- |
| Gemini GenerateContent | Images, PDF documents, audio, and video |
| Anthropic Messages | Images and PDF documents |
| OpenAI Chat Completions compatible | Images |
| OpenAI Responses | Images and PDF documents |
| Ollama Chat | Images for models advertising the `vision` capability |
| Other protocols | Text content; unsupported binary assets stop generation |

Video frames supplied as timestamped images are preserved as image parts with their timestamps.
Raw video input is currently passed only to Gemini. Audio transcripts are included as text when
they exist, alongside raw audio when Gemini is selected.

## Capability and privacy checks

Before a request is built, Tutorux checks the selected model's cached input modalities. Ollama
uses the installed model's live capability report. Unknown or unsupported modalities stop the
request so that the user can refresh the model catalog or choose a compatible model.

Unrecognized asset formats remain listed as metadata-only and are called out in the prompt.
Tutorux instructs the model not to infer their contents. Imported asset bytes are capped at 6 MiB
per request, the JSON package at 8 MiB, and the complete serialized request at 16 MiB.

Cloud generation first displays the exact serialized request, including attached asset bytes, and
its SHA-256. The follow-up `--confirm-hash` must match that request-body hash. No API key is read
until the user confirms.
