# Live local transcription

Native recording can transcribe one captured audio track as it is written:

~~~powershell
tutorux record start --session SESSION_UUID --source microphone --consent --live-transcribe --model models/ggml-base.en.bin
~~~

The model option must name a local whisper.cpp model file. Relative model paths
resolve from Tutorux's working directory. Optional settings are language
(auto or a language code), threads (1–64), and window-seconds (1–27; default
5). A build without whisper.cpp rejects the request before opening the audio
stream.

Tutorux copies committed PCM chunks into a bounded queue and transcribes them on
a separate worker. Each completed window is saved to the selected archive as
timestamped provisional transcript segments with the model, backend version,
language, source track, and run recorded. Command progress reports each saved
segment. The audio capture callback only copies and enqueues PCM; transcription
and archive writes happen on the worker. If transcription falls behind its
16 MiB queue or the model fails, audio capture continues and the transcript
error is reported. Segments already saved remain available for review.

Live transcription currently accepts one source per recording command.
Synchronized microphone plus system or application audio recordings should be
transcribed after capture with transcript generate or transcript refine and an
explicit track selection. Browser/WASM recording and imported recordings use
the post-session transcription workflow.

Whisper output is never treated as verified. Review and correct segments before
using them as evidence. Tutor-authored verification remains an explicit action;
live transcription does not create student progress classifications.
