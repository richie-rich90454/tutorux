import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js";
import type { ArchiveRecord } from "./archive/format";
import { aiPackageText, type AiPackageSummary } from "./ai/package";
import { AI_PROVIDERS, type AiProviderConfigurationInput } from "./ai/providers";
import { GUIDE_TEMPLATES, type GuideTemplate } from "./domain/guides";
import { guideTemplateFromRecord } from "./domain/templates";
import "./ai.css";

interface AiPageProps {
  sessions: readonly ArchiveRecord[];
  customTemplates: readonly ArchiveRecord[];
  jobs: readonly ArchiveRecord[];
  providerSettings: readonly ArchiveRecord[];
  credentials: readonly ArchiveRecord[];
  encrypted: boolean;
  disabled: boolean;
  busy: boolean;
  onPrepare: (sessionId: string, templateId: string) => Promise<AiPackageSummary>;
  onSave: (summary: AiPackageSummary) => Promise<boolean>;
  onLoad: (jobId: string) => Promise<ArchiveRecord | null>;
  onSaveProvider: (input: AiProviderConfigurationInput) => Promise<boolean>;
  onSaveCredential: (providerId: string, value: string) => Promise<boolean>;
  onRemoveCredential: (providerId: string) => Promise<boolean>;
}

export function AiPage(props: AiPageProps): JSX.Element {
  const [sessionId, setSessionId] = createSignal("");
  const [templateId, setTemplateId] = createSignal("auto");
  const [review, setReview] = createSignal<AiPackageSummary | null>(null);
  const [reviewed, setReviewed] = createSignal(false);
  const [showJson, setShowJson] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [providerId, setProviderId] = createSignal(AI_PROVIDERS[0]!.id);
  const [providerEndpoint, setProviderEndpoint] = createSignal(AI_PROVIDERS[0]!.defaultEndpoint);
  const [providerModel, setProviderModel] = createSignal("");
  const [providerMessage, setProviderMessage] = createSignal("");
  const [credentialInput, setCredentialInput] = createSignal("");
  const [credentialConfirmed, setCredentialConfirmed] = createSignal(false);
  const currentProvider = createMemo(
    () => AI_PROVIDERS.find((provider) => provider.id === providerId()) ?? AI_PROVIDERS[0]!,
  );
  const savedCredential = createMemo(() =>
    props.credentials.find(
      (record) =>
        record.fields.get("provider_id") === providerId() ||
        record.fields.get("key") === currentProvider().credentialKey,
    ),
  );
  const savedProvider = createMemo(() =>
    props.providerSettings.find((record) => record.fields.get("provider_id") === providerId()),
  );
  createEffect(() => {
    const provider = currentProvider();
    const saved = savedProvider();
    setProviderEndpoint(saved?.fields.get("endpoint") || provider.defaultEndpoint);
    setProviderModel(saved?.fields.get("selected_model") ?? "");
    setCredentialInput("");
    setCredentialConfirmed(false);
  });
  const templates = createMemo<GuideTemplate[]>(() => [
    ...GUIDE_TEMPLATES,
    ...props.customTemplates.map(guideTemplateFromRecord),
  ]);
  const latestJobs = createMemo(() =>
    [...props.jobs]
      .filter((job) => job.fields.get("mode") === "manual")
      .sort((left, right) => compareTimestamp(right, left))
      .slice(0, 12),
  );

  async function prepare(): Promise<void> {
    setMessage("");
    setReview(null);
    setReviewed(false);
    setShowJson(false);
    try {
      const summary = await props.onPrepare(sessionId(), templateId());
      setReview(summary);
      setMessage("Package assembled locally. Nothing has been sent or saved yet.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The package could not be prepared.");
    }
  }

  async function saveReview(): Promise<void> {
    const summary = review();
    if (!summary || !reviewed()) return;
    const saved = await props.onSave(summary);
    if (saved) {
      setReview(null);
      setReviewed(false);
      setShowJson(false);
      setMessage("Reviewed package saved in this archive. No provider was contacted.");
    }
  }

  async function download(jobId: string): Promise<void> {
    try {
      const job = await props.onLoad(jobId);
      if (!job) throw new Error("That package is no longer available in the active archive.");
      const text = aiPackageText(job);
      const blob = new Blob([text], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `Tutorux-AI-${job.fields.get("session_id") ?? job.id}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The package could not be exported.");
    }
  }

  async function saveProvider(): Promise<void> {
    setProviderMessage("");
    try {
      const input: AiProviderConfigurationInput = {
        providerId: currentProvider().id,
        endpoint: providerEndpoint(),
        model: providerModel(),
      };
      const saved = await props.onSaveProvider(input);
      if (saved)
        setProviderMessage("Provider settings saved. No connection test or request was made.");
    } catch (cause) {
      setProviderMessage(
        cause instanceof Error ? cause.message : "Provider settings could not be saved.",
      );
    }
  }

  async function saveCredential(): Promise<void> {
    setProviderMessage("");
    if (!credentialConfirmed()) {
      setProviderMessage("Confirm encrypted storage before saving this API key.");
      return;
    }
    try {
      const saved = await props.onSaveCredential(currentProvider().id, credentialInput());
      if (saved) {
        setCredentialInput("");
        setCredentialConfirmed(false);
        setProviderMessage(
          "API key saved in this encrypted archive. The value is hidden after saving.",
        );
      }
    } catch (cause) {
      setProviderMessage(
        cause instanceof Error ? cause.message : "The API key could not be saved.",
      );
    }
  }

  async function removeCredential(): Promise<void> {
    setProviderMessage("");
    try {
      const removed = await props.onRemoveCredential(currentProvider().id);
      if (removed) setProviderMessage("Saved API key removed from this archive.");
    } catch (cause) {
      setProviderMessage(
        cause instanceof Error ? cause.message : "The saved API key could not be removed.",
      );
    }
  }

  return (
    <div class="page-body ai-page">
      <section class="record-heading ai-heading">
        <div>
          <span class="eyebrow">PRIVATE BY DEFAULT</span>
          <h1>AI workspace</h1>
          <p>
            Prepare a source-linked study-guide handoff. Packages stay in your archive until you
            choose to export them.
          </p>
        </div>
        <div class="ai-state-pill">
          <span /> Nothing sent
        </div>
      </section>

      <section class="ai-intro-card" aria-label="Package privacy summary">
        <div class="ai-intro-icon" aria-hidden="true">
          ✳
        </div>
        <div>
          <strong>Review first. Share only when you choose.</strong>
          <p>
            A package contains the selected session, its transcripts, observations, evidence,
            material names, and limited learning-profile context. It excludes private tutor notes
            and material file bytes. Preparing or saving it makes no network request.
          </p>
        </div>
      </section>

      <section class="ai-panel ai-provider-panel" aria-labelledby="ai-provider-title">
        <div class="ai-panel-heading">
          <div>
            <span class="eyebrow">LOCAL SETUP · NO CONNECTION TEST</span>
            <h2 id="ai-provider-title">Provider settings</h2>
          </div>
          <span class="ai-provider-status">
            {savedProvider() ? "Configured" : "Not configured"}
          </span>
        </div>
        <p class="ai-provider-intro">
          Save a provider and model for a future reviewed request. This setup does not connect to a
          service or send session data.
        </p>
        <div class="ai-form-grid">
          <label class="ai-field">
            <span>Provider</span>
            <select
              aria-label="AI provider"
              value={providerId()}
              disabled={props.disabled || props.busy}
              onChange={(event) => {
                setProviderMessage("");
                setProviderId(event.currentTarget.value);
              }}
            >
              <For each={AI_PROVIDERS}>
                {(provider) => <option value={provider.id}>{provider.name}</option>}
              </For>
            </select>
          </label>
          <label class="ai-field">
            <span>Model ID</span>
            <input
              aria-label="AI model ID"
              type="text"
              value={providerModel()}
              maxlength={256}
              placeholder="Enter the model ID provided by the service"
              disabled={props.disabled || props.busy}
              onInput={(event) => setProviderModel(event.currentTarget.value)}
            />
          </label>
          <label class="ai-field ai-provider-endpoint">
            <span>Endpoint</span>
            <input
              aria-label="Provider endpoint"
              type="url"
              value={providerEndpoint()}
              maxlength={2048}
              placeholder={currentProvider().defaultEndpoint || "https://provider.example/v1"}
              disabled={props.disabled || props.busy}
              onInput={(event) => setProviderEndpoint(event.currentTarget.value)}
            />
          </label>
        </div>
        <div class="ai-provider-protocol">
          <span>{currentProvider().protocol}</span>
          <span>{currentProvider().local ? "Loopback only" : "HTTPS only"}</span>
        </div>
        <Show when={!currentProvider().local}>
          <div class="ai-credential-box">
            <div class="ai-credential-copy">
              <strong>API key</strong>
              <span>
                {savedCredential()
                  ? "A key is saved in this archive. Its value is never shown here."
                  : props.encrypted
                    ? "Keys are stored as encrypted archive records."
                    : "Encrypt this archive before saving an API key."}
              </span>
            </div>
            <Show
              when={savedCredential()}
              fallback={
                <div class="ai-credential-editor">
                  <input
                    aria-label="Provider API key"
                    type="password"
                    autocomplete="new-password"
                    spellcheck={false}
                    value={credentialInput()}
                    maxlength={4096}
                    placeholder="Paste an API key"
                    disabled={props.disabled || props.busy || !props.encrypted}
                    onInput={(event) => setCredentialInput(event.currentTarget.value)}
                  />
                  <label class="ai-review-consent ai-credential-consent">
                    <input
                      type="checkbox"
                      checked={credentialConfirmed()}
                      disabled={props.disabled || props.busy || !props.encrypted}
                      onChange={(event) => setCredentialConfirmed(event.currentTarget.checked)}
                    />
                    <span>I understand this key will be stored inside the encrypted archive.</span>
                  </label>
                  <button
                    class="button button-outline"
                    type="button"
                    disabled={
                      props.disabled || props.busy || !props.encrypted || !credentialInput()
                    }
                    onClick={() => void saveCredential()}
                  >
                    Save key securely
                  </button>
                </div>
              }
            >
              <button
                class="button button-quiet ai-remove-key"
                type="button"
                disabled={props.disabled || props.busy}
                onClick={() => void removeCredential()}
              >
                Remove saved key
              </button>
            </Show>
          </div>
        </Show>
        <div class="ai-provider-footer">
          <p>
            {currentProvider().description}. Endpoint and model settings are archive records; API
            keys are separate encrypted records.
          </p>
          <button
            class="button button-primary"
            type="button"
            disabled={props.disabled || props.busy}
            onClick={() => void saveProvider()}
          >
            Save provider settings
          </button>
        </div>
        <Show when={providerMessage()}>
          <p class="ai-message" role="status">
            {providerMessage()}
          </p>
        </Show>
      </section>

      <section class="ai-panel" aria-labelledby="ai-prepare-title">
        <div class="ai-panel-heading">
          <div>
            <span class="eyebrow">NO API KEY REQUIRED</span>
            <h2 id="ai-prepare-title">Prepare a guide package</h2>
          </div>
          <span class="ai-step-marker">
            01 <i /> 02 <i /> 03
          </span>
        </div>
        <div class="ai-form-grid">
          <label class="ai-field">
            <span>Session</span>
            <select
              aria-label="Session to prepare"
              value={sessionId()}
              disabled={props.disabled || props.busy || props.sessions.length === 0}
              onChange={(event) => {
                setSessionId(event.currentTarget.value);
                setReview(null);
                setReviewed(false);
              }}
            >
              <option value="">Choose a session…</option>
              <For each={props.sessions}>
                {(session) => (
                  <option value={session.id}>
                    {session.fields.get("title") ||
                      session.fields.get("subject") ||
                      "Untitled session"}
                    {session.fields.get("started_at_us")
                      ? ` · ${formatDate(session.fields.get("started_at_us") ?? "")}`
                      : ""}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="ai-field">
            <span>Guide structure</span>
            <select
              value={templateId()}
              disabled={props.disabled || props.busy}
              onChange={(event) => {
                setTemplateId(event.currentTarget.value);
                setReview(null);
                setReviewed(false);
              }}
            >
              <option value="auto">Choose from student preference and session subject</option>
              <For each={templates()}>
                {(template) => <option value={template.id}>{template.name}</option>}
              </For>
            </select>
          </label>
        </div>
        <div class="ai-form-footer">
          <p>Session source text is treated as untrusted content in the package instructions.</p>
          <button
            class="button button-primary"
            type="button"
            disabled={props.disabled || props.busy || !sessionId()}
            onClick={() => void prepare()}
          >
            {props.busy ? "Preparing…" : "Prepare for review"}
            <span aria-hidden="true">→</span>
          </button>
        </div>
        <Show when={message()}>
          <p class="ai-message" role="status">
            {message()}
          </p>
        </Show>
      </section>

      <Show when={review()}>
        {(summary) => (
          <section class="ai-review-card" aria-labelledby="ai-review-title">
            <div class="ai-review-heading">
              <div>
                <span class="eyebrow">PACKAGE READY FOR YOUR REVIEW</span>
                <h2 id="ai-review-title">{summary().guideTemplateName}</h2>
              </div>
              <span class="ai-hash-label">SHA-256 · {summary().contentHash.slice(0, 16)}…</span>
            </div>
            <div class="ai-review-stats">
              <ReviewStat label="Transcript cues" value={summary().transcriptCount} />
              <ReviewStat label="Observations" value={summary().annotationCount} />
              <ReviewStat label="Evidence items" value={summary().evidenceCount} />
              <ReviewStat label="Material names" value={summary().assetCount} />
              <ReviewStat label="Package size" value={formatBytes(summary().byteLength)} />
            </div>
            <details
              class="ai-json-disclosure"
              onToggle={(event) => setShowJson((event.currentTarget as HTMLDetailsElement).open)}
            >
              <summary>Inspect the complete package JSON</summary>
              <Show when={showJson()}>
                <textarea
                  aria-label="Complete AI package JSON"
                  readOnly
                  value={aiPackageText(summary().job)}
                />
              </Show>
            </details>
            <label class="ai-review-consent">
              <input
                type="checkbox"
                checked={reviewed()}
                onChange={(event) => setReviewed(event.currentTarget.checked)}
              />
              <span>
                I reviewed the package contents and want to store this copy in the selected archive.
              </span>
            </label>
            <div class="ai-review-actions">
              <button class="button button-quiet" type="button" onClick={() => setReview(null)}>
                Discard draft
              </button>
              <button
                class="button button-primary"
                type="button"
                disabled={!reviewed() || props.busy || props.disabled}
                onClick={() => void saveReview()}
              >
                Save reviewed package
              </button>
            </div>
          </section>
        )}
      </Show>

      <section class="ai-panel ai-history" aria-labelledby="ai-history-title">
        <div class="ai-panel-heading">
          <div>
            <span class="eyebrow">KEPT WITH YOUR WORKSPACE</span>
            <h2 id="ai-history-title">Prepared packages</h2>
          </div>
          <span class="ai-history-count">{latestJobs().length} recent</span>
        </div>
        <Show
          when={latestJobs().length > 0}
          fallback={
            <div class="ai-empty-state">
              <span aria-hidden="true">✳</span>
              <strong>No packages prepared yet</strong>
              <p>Choose a session above to create a source-linked package for your review.</p>
            </div>
          }
        >
          <div class="ai-job-list">
            <For each={latestJobs()}>
              {(job) => (
                <div class="ai-job-row">
                  <div class="ai-job-icon" aria-hidden="true">
                    ✳
                  </div>
                  <div class="ai-job-copy">
                    <strong>
                      {sessionLabel(props.sessions, job.fields.get("session_id") ?? "")}
                    </strong>
                    <span>
                      Saved {formatDate(job.fields.get("created_at_us") ?? "")} ·{" "}
                      {formatBytes(jobSize(job))}
                    </span>
                  </div>
                  <button
                    class="button button-outline ai-export-button"
                    type="button"
                    disabled={props.disabled || props.busy}
                    onClick={() => void download(job.id)}
                  >
                    Export JSON
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.jobs.some((job) => job.fields.get("mode") !== "manual")}>
          <p class="ai-future-note">
            Other AI job types are preserved in the archive and will appear here as their review
            workflows are ported.
          </p>
        </Show>
      </section>
    </div>
  );
}

function ReviewStat(props: { label: string; value: string | number }): JSX.Element {
  return (
    <div class="ai-review-stat">
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </div>
  );
}

function sessionLabel(sessions: readonly ArchiveRecord[], id: string): string {
  const session = sessions.find((item) => item.id.toLowerCase() === id.toLowerCase());
  return session?.fields.get("title") || session?.fields.get("subject") || "Session package";
}

function compareTimestamp(left: ArchiveRecord, right: ArchiveRecord): number {
  const a = parseTimestamp(left.fields.get("created_at_us"));
  const b = parseTimestamp(right.fields.get("created_at_us"));
  return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
}

function parseTimestamp(value: string | undefined): bigint {
  return value && /^\d+$/u.test(value) ? BigInt(value) : 0n;
}

function formatDate(microseconds: string): string {
  try {
    const milliseconds = Number(BigInt(microseconds) / 1000n);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "date unavailable";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date(milliseconds),
    );
  } catch {
    return "date unavailable";
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const megabytes = size / (1024 * 1024);
  return megabytes >= 1 ? `${megabytes.toFixed(1)} MB` : `${(size / 1024).toFixed(1)} KB`;
}

function jobSize(job: ArchiveRecord): number {
  const parsed = Number(job.fields.get("package_bytes") ?? "");
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : job.blob.byteLength;
}
