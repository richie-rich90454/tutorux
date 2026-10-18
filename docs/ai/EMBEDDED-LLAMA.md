# Embedded llama.cpp

The Full desktop profile contains the pinned llama.cpp runtime. Compact builds keep the external
Ollama and llama.cpp server adapters and return a clear unsupported-build error for embedded
inference. Neither profile bundles model weights.

Choose a GGUF file explicitly and save its path in the active archive:

```text
model inspect --path models/lesson-model.gguf
model select --provider llama.cpp-embedded --model lesson-model \
  --path models/lesson-model.gguf --context-tokens 4096 --threads 0 --gpu-layers 0
```

Relative paths resolve beside the archive. Tutorux does not search global model folders or move
model files. GGUF inspection reports architecture metadata and a conservative memory upper bound.
Generation checks available system memory before loading; pass
`--allow-memory-overcommit` only after reviewing the estimate.

The selected model's context, CPU thread cap, and GPU layer count are stored in the archive.
Generation accepts the same options to override them for one request. `--threads 0` selects an
automatically bounded CPU thread count; `--max-threads` caps it at 64. GPU offload defaults to zero.
CUDA, Vulkan, or Metal support must be enabled when building Tutorux, and requesting offload from a
CPU-only build returns an explicit error.

Local generation uses a local JSON AI package, does not open an HTTP endpoint, and loads the model
only for the request. The runtime, model, context, and sampler are released after generation or
failure. Cancellation is checked during token generation. LLM weights remain external files.

Embedded generation consumes the canonical Tutorux content parts. The current embedded adapter is
text-only: it uses extracted document text and audio/video transcripts when available, and labels
them when the corresponding source bytes or frames are omitted. It returns a capability error for
images and for documents or recordings without usable extracted text. It does not infer multimodal
support from a model name or GGUF metadata. Use Ollama, a compatible server, or a cloud model whose
discovered capabilities include the required input modality when source media must be sent to a
model.
