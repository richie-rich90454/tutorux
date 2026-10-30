import { For, Show, createEffect, createSignal, type JSX } from "solid-js";
import { deterministicUuid } from "./ai/providers";
import { hasSensitiveCredentialMaterial, sensitiveSettingKey } from "./archive/sanitized-copy";
import { RecordType, type ArchiveRecord } from "./archive/format";
import { moveRecordToTrash } from "./domain/records";
import { platform } from "@platform";
import "./archive-settings.css";

interface ArchiveSettingsProps {
  displayName: string;
  encrypted: boolean;
  records: ArchiveRecord[];
  disabled: boolean;
  onSave: (records: ArchiveRecord[], message: string) => Promise<boolean>;
  onRename: (displayName: string) => Promise<boolean>;
  onEnableEncryption: (passphrase: string) => Promise<void>;
}

const field = (record: ArchiveRecord, key: string): string => record.fields.get(key) ?? "";

function validateSetting(key: string, value: string): void {
  if (
    !key.trim() ||
    [...key].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 0x20 || code === 0x7f;
    }) ||
    new TextEncoder().encode(key).length > 512
  ) {
    throw new Error(
      "Setting keys must be nonempty, contain no control characters, and fit within 512 bytes.",
    );
  }
  if (sensitiveSettingKey(key))
    throw new Error("Manage credentials in the AI workspace, not ordinary settings.");
  if (value.includes("\0") || new TextEncoder().encode(value).length > 1024 * 1024) {
    throw new Error("Setting values must contain no NUL and fit within 1 MiB.");
  }
}

async function makeSetting(
  key: string,
  value: string,
  current?: ArchiveRecord,
): Promise<ArchiveRecord> {
  validateSetting(key, value);
  const fields = new Map(current?.fields ?? []);
  fields.set("record_role", "setting");
  fields.set("key", key);
  fields.set("value", value);
  fields.set("updated_at_us", (BigInt(Date.now()) * 1000n).toString());
  fields.delete("_deleted");
  fields.delete("deleted_at_us");
  return {
    type: RecordType.settings,
    id: current?.id ?? (await deterministicUuid(`setting:${key}`)),
    revision: current?.revision ?? 0n,
    previousOffset: current?.previousOffset ?? 0n,
    blob: current?.blob ?? new Uint8Array(),
    fields,
  };
}

/** A graphical editor for ordinary archive settings; credentials remain in the AI workspace. */
export function ArchiveSettings(props: ArchiveSettingsProps): JSX.Element {
  const [archiveName, setArchiveName] = createSignal(props.displayName);
  const [renameError, setRenameError] = createSignal("");
  const [renameStatus, setRenameStatus] = createSignal("");
  const [renameBusy, setRenameBusy] = createSignal(false);
  const [encryptionBusy, setEncryptionBusy] = createSignal(false);
  const [encryptionError, setEncryptionError] = createSignal("");
  const [key, setKey] = createSignal("");
  const [value, setValue] = createSignal("");
  const [editing, setEditing] = createSignal<ArchiveRecord | null>(null);
  const [error, setError] = createSignal("");
  const [confirmReset, setConfirmReset] = createSignal(false);
  createEffect(() => setArchiveName(props.displayName));
  const visible = () =>
    props.records
      .filter(
        (record) =>
          field(record, "record_role") === "setting" &&
          field(record, "_deleted") !== "true" &&
          !hasSensitiveCredentialMaterial(record),
      )
      .slice()
      .sort((a, b) => field(a, "key").localeCompare(field(b, "key")));

  async function renameArchive(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setRenameError("");
    setRenameStatus("");
    const name = archiveName().trim();
    if (!name) {
      setRenameError("Archive name must not be empty.");
      return;
    }
    if (name.length > 200) {
      setRenameError("Archive names must be 200 characters or fewer.");
      return;
    }
    if (name === props.displayName) {
      setArchiveName(name);
      setRenameStatus("The archive name is unchanged.");
      return;
    }

    setRenameBusy(true);
    try {
      if (await props.onRename(name)) {
        setArchiveName(name);
        setRenameStatus(
          "Archive name updated in the workspace. Save the workspace to write it to disk.",
        );
      } else {
        setRenameError(
          "The archive name could not be updated. Review the notification for details.",
        );
      }
    } catch (cause) {
      setRenameError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRenameBusy(false);
    }
  }

  async function enableEncryption(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setEncryptionError("");
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const passphrase = String(formData.get("archivePassphrase") ?? "");
    const confirmation = String(formData.get("archivePassphraseConfirmation") ?? "");
    const passphraseBytes = new TextEncoder().encode(passphrase);
    const byteLength = passphraseBytes.byteLength;
    const validUnicode = new TextDecoder().decode(passphraseBytes) === passphrase;
    passphraseBytes.fill(0);
    if (!validUnicode) {
      setEncryptionError("Enter a passphrase using valid Unicode text.");
      return;
    }
    if (byteLength < 12 || byteLength > 4096) {
      setEncryptionError("Use a passphrase between 12 and 4096 UTF-8 bytes long.");
      return;
    }
    if (passphrase !== confirmation) {
      setEncryptionError("The passphrases do not match.");
      return;
    }

    setEncryptionBusy(true);
    const inputs = form.querySelectorAll<HTMLInputElement>('input[type="password"]');
    try {
      await props.onEnableEncryption(passphrase);
      form.reset();
    } catch (cause) {
      setEncryptionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      for (const input of inputs) input.value = "";
      setEncryptionBusy(false);
    }
  }

  function clear(): void {
    setKey("");
    setValue("");
    setEditing(null);
    setError("");
  }
  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    try {
      const existing = editing();
      if (
        !existing &&
        props.records.some(
          (record) =>
            field(record, "record_role") === "setting" &&
            field(record, "_deleted") !== "true" &&
            field(record, "key") === key(),
        )
      )
        throw new Error("That key already exists. Select Edit to change it.");
      const record = await makeSetting(key(), value(), existing ?? undefined);
      if (await props.onSave([record], "Archive setting saved.")) clear();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function importFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error("Settings file must fit within 1 MiB.");
      const contents = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      const imported = new Map<string, ArchiveRecord>();
      for (const [index, line] of contents.split(/\r?\n/u).entries()) {
        if (!line || line.startsWith("#")) continue;
        const separator = line.indexOf("=");
        if (separator <= 0) throw new Error(`Expected key=value on line ${index + 1}.`);
        const name = line.slice(0, separator);
        if (imported.has(name)) throw new Error(`The settings file repeats key “${name}”.`);
        const existing = props.records.find(
          (record) => field(record, "record_role") === "setting" && field(record, "key") === name,
        );
        if (existing && hasSensitiveCredentialMaterial(existing))
          throw new Error(
            "A matching setting contains sensitive material and cannot be imported here.",
          );
        imported.set(name, await makeSetting(name, line.slice(separator + 1), existing));
      }
      if (!imported.size) throw new Error("The settings file contains no settings.");
      if (await props.onSave([...imported.values()], `Imported ${imported.size} archive settings.`))
        clear();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function exportSettings(): Promise<void> {
    try {
      const records = visible();
      if (
        records.some(
          (record) =>
            /[\r\n=]/u.test(field(record, "key")) ||
            field(record, "key").startsWith("#") ||
            /[\r\n]/u.test(field(record, "value")),
        )
      )
        throw new Error("Settings containing line breaks cannot be exported as key=value text.");
      await platform.exportTextFile(
        "tutorux-settings.txt",
        records.map((record) => `${field(record, "key")}=${field(record, "value")}`).join("\n") +
          "\n",
        "text/plain;charset=utf-8",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <section class="settings-section archive-settings">
      <div class="settings-section-heading">
        <h2>Archive settings</h2>
        <p>
          Review and edit settings stored in this archive. Provider credentials are managed in the
          AI workspace.
        </p>
      </div>
      <form
        class="archive-setting-form archive-name-form"
        onSubmit={(event) => void renameArchive(event)}
      >
        <h3>Archive name</h3>
        <label class="form-field" for="archive-display-name">
          Display name
          <input
            id="archive-display-name"
            value={archiveName()}
            maxlength="200"
            required
            disabled={props.disabled || renameBusy()}
            aria-invalid={Boolean(renameError())}
            aria-describedby="archive-display-name-help"
            onInput={(event) => {
              setArchiveName(event.currentTarget.value);
              setRenameError("");
              setRenameStatus("");
            }}
          />
        </label>
        <p id="archive-display-name-help">
          Use up to 200 characters. The name is stored in this archive.
        </p>
        <Show when={renameError()}>
          <p class="archive-settings-error" role="alert">
            {renameError()}
          </p>
        </Show>
        <Show when={renameStatus()}>
          <p role="status" aria-live="polite">
            {renameStatus()}
          </p>
        </Show>
        <div class="archive-setting-actions">
          <button
            class="button button-primary"
            type="submit"
            disabled={props.disabled || renameBusy()}
          >
            {renameBusy() ? "Saving name…" : "Save archive name"}
          </button>
        </div>
      </form>
      <Show when={!props.encrypted}>
        <form class="archive-setting-form archive-encryption-form" onSubmit={enableEncryption}>
          <h3>Protect this archive</h3>
          <p>
            Encrypt every retained revision with a new key. Save the workspace after this finishes
            to replace the archive file with its encrypted version.
          </p>
          <label class="form-field" for="archive-encryption-passphrase">
            New passphrase
            <input
              id="archive-encryption-passphrase"
              name="archivePassphrase"
              type="password"
              autocomplete="new-password"
              minlength="12"
              maxlength="4096"
              required
              disabled={props.disabled || encryptionBusy()}
            />
          </label>
          <label class="form-field" for="archive-encryption-confirmation">
            Confirm passphrase
            <input
              id="archive-encryption-confirmation"
              name="archivePassphraseConfirmation"
              type="password"
              autocomplete="new-password"
              minlength="12"
              maxlength="4096"
              required
              disabled={props.disabled || encryptionBusy()}
            />
          </label>
          <p>Use 12–4096 UTF-8 bytes. Tutorux cannot recover a lost passphrase.</p>
          <Show when={encryptionError()}>
            <p class="archive-settings-error" role="alert">
              {encryptionError()}
            </p>
          </Show>
          <div class="archive-setting-actions">
            <button
              class="button button-primary"
              type="submit"
              disabled={props.disabled || encryptionBusy()}
            >
              {encryptionBusy() ? "Encrypting archive…" : "Enable encryption"}
            </button>
          </div>
        </form>
      </Show>
      <Show when={error()}>
        <p class="archive-settings-error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="archive-settings-list">
        <Show
          when={visible().length}
          fallback={<p class="archive-settings-empty">No ordinary archive settings yet.</p>}
        >
          <For each={visible()}>
            {(record) => (
              <div class="archive-setting-row">
                <div>
                  <strong>{field(record, "key")}</strong>
                  <pre>{field(record, "value") || "(empty)"}</pre>
                </div>
                <div class="archive-setting-actions">
                  <button
                    class="button button-outline"
                    type="button"
                    disabled={props.disabled}
                    onClick={() => {
                      setEditing(record);
                      setKey(field(record, "key"));
                      setValue(field(record, "value"));
                      setError("");
                    }}
                  >
                    Edit
                  </button>
                  <button
                    class="button button-quiet"
                    type="button"
                    disabled={props.disabled}
                    onClick={() =>
                      void props.onSave([moveRecordToTrash(record)], "Archive setting reset.")
                    }
                  >
                    Reset
                  </button>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>
      <form class="archive-setting-form" onSubmit={(event) => void save(event)}>
        <h3>{editing() ? "Edit setting" : "Add a setting"}</h3>
        <label class="form-field">
          Key
          <input
            value={key()}
            readonly={!!editing()}
            disabled={props.disabled}
            onInput={(event) => setKey(event.currentTarget.value)}
            required
          />
        </label>
        <label class="form-field">
          Value
          <textarea
            value={value()}
            disabled={props.disabled}
            onInput={(event) => setValue(event.currentTarget.value)}
            rows="3"
          />
        </label>
        <div class="archive-setting-actions">
          <Show when={editing()}>
            <button class="button button-quiet" type="button" onClick={clear}>
              Cancel
            </button>
          </Show>
          <button class="button button-primary" type="submit" disabled={props.disabled}>
            Save setting
          </button>
        </div>
      </form>
      <div class="archive-settings-transfer">
        <label class="button button-outline archive-settings-import">
          Import key=value file
          <input
            type="file"
            accept=".txt,text/plain"
            disabled={props.disabled}
            onChange={(event) => void importFile(event)}
          />
        </label>
        <button
          class="button button-outline"
          type="button"
          disabled={!visible().length}
          onClick={() => void exportSettings()}
        >
          Export settings
        </button>
        <button
          class="button button-quiet"
          type="button"
          disabled={props.disabled || !visible().length}
          onClick={() => setConfirmReset(true)}
        >
          Reset visible settings
        </button>
      </div>
      <Show when={confirmReset()}>
        <div class="archive-settings-confirm" role="group" aria-label="Confirm settings reset">
          <p>Reset all {visible().length} visible settings in this archive?</p>
          <button class="button button-quiet" type="button" onClick={() => setConfirmReset(false)}>
            Cancel
          </button>
          <button
            class="button button-outline"
            type="button"
            disabled={props.disabled}
            onClick={() => {
              const records = visible().map(moveRecordToTrash);
              void props.onSave(records, "Archive settings reset.").then((saved) => {
                if (saved) {
                  setConfirmReset(false);
                  clear();
                }
              });
            }}
          >
            Reset settings
          </button>
        </div>
      </Show>
    </section>
  );
}
