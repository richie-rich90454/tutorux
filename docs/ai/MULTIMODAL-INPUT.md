> **Migration reference:** This document describes behavior, implementation, or build details from the former C++/Slint application. It remains useful as a porting specification; current TypeScript coverage is tracked in [the feature inventory](../migration/feature-inventory.md). Historical build commands are not the active TypeScript workflow.

# Multimodal AI input

Tutorux uses one typed generation-content representation for text, images, audio, documents, and
video. Provider adapters serialize those parts into their native request formats; an adapter never
silently drops binary content.

## Asset handling

An AI package records the asset IDs, MIME types, and content hashes. At generation time Tutorux
reopens each supported asset from the active archive, verifies its content hash and byte count, and
attaches its bytes to the request. The stored AI package remains small and does not duplicate asset
blobs.

Protocol adapters can encode these binary inputs:

| Provider protocol | Adapter wire-format support |
| --- | --- |
| Gemini GenerateContent | Images, PDF documents, audio, and video |
| Anthropic Messages | Images and PDF documents |
| OpenAI Chat Completions compatible | Images |
| OpenAI Responses | Images and PDF documents |
| Ollama Chat | Images for models advertising the `vision` capability |
| Embedded llama.cpp | Extracted document text and transcript text; source media bytes are not sent |
| Other protocols | Text content; unsupported binary assets stop generation |

Video frames supplied as timestamped images are preserved as image parts with their timestamps.
Raw video input is currently passed only to Gemini. Audio transcripts are included as text when
they exist, alongside raw audio when Gemini is selected.
The embedded llama.cpp adapter accepts transcript and extracted document text through the same
typed content representation, but it does not currently load a multimodal projector or process
image, audio, or video bytes. It labels text extracted from media to make clear when the original
bytes or frames were omitted, and reports a capability error if no usable text is available.

The table describes adapter encoding. A model must also advertise the requested input modality in
its cached model metadata before Tutorux includes any asset bytes in a generation request. API
model lists that do not publish per-model input modalities leave those capabilities unknown;
Tutorux blocks those binary inputs until a refreshed catalog supplies them. This prevents a
provider protocol's general abilities from being mistaken for a selected model's actual abilities.

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
