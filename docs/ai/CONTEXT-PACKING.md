# AI context planning

Inspect the evidence selected for a model context before preparing an AI package:

```text
tutorux --archive Tutorux.tux ai context --session SESSION_UUID --token-budget 16000
tutorux --archive Tutorux.tux ai context --session SESSION_UUID \
  --token-budget 16000 --max-item-tokens 3000 --json
```

The planner prioritizes tutor annotations and reviewed evidence, then uses source confidence,
update time, and stable IDs to make selection repeatable. It includes transcript text and extracted
asset text only at complete UTF-8 boundaries. Long sources may be split between paragraphs or lines;
each fragment reports its byte range in the source record. Items that exceed a per-item limit or
the remaining budget appear in `omitted` with a reason. Check `complete` before using a preview as a
complete account of the session.

The built-in token counter estimates one token per three UTF-8 bytes. It is a conservative planning
proxy, not a provider tokenizer or a promise that a provider will accept a request. The command is
read-only and sends no session data over the network. Actual generation still requires a package,
an explicit provider selection, and the existing outbound confirmation flow for cloud requests.
