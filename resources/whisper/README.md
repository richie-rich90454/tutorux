# Bundled Whisper model

Tutorux packages `ggml-base-q5_1.bin` and uses it through the native `whisper-rs` backend for both full-track and live transcription. The model bytes are embedded in the Rust application executable, so MSI, NSIS, and portable builds all have the same offline transcription capability and do not extract a model at startup.

- Model: multilingual Whisper Base, Q5_1 quantization
- Source: [whisper.cpp model repository](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin)
- Upstream project: [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- Size: 59,707,625 bytes
- SHA-256: `422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898`
- Model license: MIT, inherited from the OpenAI Whisper model; see the [Whisper license](https://github.com/openai/whisper/blob/main/LICENSE)

The application loads this static byte array directly from the executable. It does not download model data, ask the user to locate model files, or write model files to temporary storage.
