import { For, Show, createResource, createSignal, onMount, type JSX } from "solid-js";
import {
    errorMessage,
    guides as guidesApi,
    sessions as sessionsApi,
    students as studentsApi,
} from "../../api/client";
import {
    AI_PROVIDERS,
    hasAiKey,
    providerById,
    removeAiKey,
    saveAiKey,
    sendAiMessage,
} from "../../api/ai";
import {
    embeddedModelRuntimeAvailable,
    loadEmbeddedModel,
    readEmbeddedModelStatus,
    selectAndInspectEmbeddedModel,
    type EmbeddedModelInfo,
    type EmbeddedModelStatus,
} from "../../api/embedded-ai";
import {
    Badge,
    Button,
    Field,
    InlineNotice,
    PageHeader,
    Panel,
    PanelHeader,
    Select,
    TextArea,
    TextInput,
} from "../../design-system/ui";
import { formatDate } from "../../shared/format";
import { navigate, sessionPath } from "../../app/router";
import { useWorkspace } from "../../app/workspace";

type Task =
    | "summarize-session"
    | "generate-guide"
    | "draft-feedback"
    | "quiz"
    | "next-lesson"
    | "chat"
    | "actions";

const TASKS: Array<{ id: Task; label: string; description: string; needsSession: boolean }> = [
    {
        id: "summarize-session",
        label: "Summarize a session",
        description: "A concise summary of what happened and what matters.",
        needsSession: true,
    },
    {
        id: "generate-guide",
        label: "Generate a study guide",
        description: "A learner-facing guide that can be edited and exported.",
        needsSession: true,
    },
    {
        id: "draft-feedback",
        label: "Draft student feedback",
        description: "Specific, kind feedback grounded in the session.",
        needsSession: true,
    },
    {
        id: "quiz",
        label: "Create quiz or flashcards",
        description: "Practice questions based on the lesson.",
        needsSession: true,
    },
    {
        id: "next-lesson",
        label: "Plan the next lesson",
        description: "Follow-up priorities and a short lesson plan.",
        needsSession: true,
    },
    {
        id: "actions",
        label: "Extract action items",
        description: "Pull out follow-ups and next steps.",
        needsSession: true,
    },
    {
        id: "chat",
        label: "Ask about a student",
        description: "Use the student's sessions, goals, and evidence as context.",
        needsSession: false,
    },
];

function taskPrompt(task: Task): string {
    switch (task) {
        case "summarize-session":
            return "Summarize this tutoring session in 5–8 short bullets. Include what was worked on, what the student understood, what remains fragile, and one recommended next step.";
        case "generate-guide":
            return "Write a learner-facing study guide in Markdown. Use short sections, concrete examples, and a short practice set. Do not invent facts that are not in the context.";
        case "draft-feedback":
            return "Draft feedback for the student or parent. Be specific, warm, and honest. Include one strength, one area to practise, and one concrete next step.";
        case "quiz":
            return "Create 8 practice questions and 6 flashcards from this session. Include answers. Keep the difficulty appropriate to the student.";
        case "next-lesson":
            return "Plan the next lesson. Include a 5-minute warm-up, the main teaching focus, one guided example, independent practice, and a quick check for understanding.";
        case "actions":
            return "Extract the concrete action items from the session. For each, say who does it and when it should happen. Keep it short.";
        case "chat":
            return "Answer the tutor's question using only the student context. If the context does not contain the answer, say so.";
    }
}

export function AssistantPage(): JSX.Element {
    const workspace = useWorkspace();
    const savedProvider = localStorage.getItem("tutorux.ai.provider") ?? "openai";
    const [providerId, setProviderId] = createSignal(savedProvider);
    const [model, setModel] = createSignal(
        localStorage.getItem(`tutorux.ai.model.${savedProvider}`) ??
            providerById(savedProvider).defaultModel,
    );
    const [keyInput, setKeyInput] = createSignal("");
    const [keyPresent, setKeyPresent] = createSignal(false);
    const [keyMessage, setKeyMessage] = createSignal("");
    const [task, setTask] = createSignal<Task>("summarize-session");
    const [sessionId, setSessionId] = createSignal("");
    const [studentId, setStudentId] = createSignal("");
    const [question, setQuestion] = createSignal("");
    const [confirmed, setConfirmed] = createSignal(false);
    const [preview, setPreview] = createSignal(false);
    const [sending, setSending] = createSignal(false);
    const [response, setResponse] = createSignal("");
    const [error, setError] = createSignal("");
    const [message, setMessage] = createSignal("");
    const [sessions] = createResource(() => sessionsApi.list(null, null, 500));
    const [students] = createResource(() => studentsApi.list(""));
    const [embeddedInfo, setEmbeddedInfo] = createSignal<EmbeddedModelInfo | null>(null);
    const [embeddedStatus, setEmbeddedStatus] = createSignal<EmbeddedModelStatus | null>(null);
    const [embeddedBusy, setEmbeddedBusy] = createSignal(false);
    const [embeddedMessage, setEmbeddedMessage] = createSignal("");

    const provider = (): ReturnType<typeof providerById> => providerById(providerId());

    const refreshKey = async (id: string): Promise<void> => {
        try {
            setKeyPresent(await hasAiKey(id));
        } catch {
            setKeyPresent(false);
        }
    };
    onMount(() => {
        void refreshKey(providerId());
        if (embeddedModelRuntimeAvailable()) {
            void readEmbeddedModelStatus()
                .then(setEmbeddedStatus)
                .catch(() => setEmbeddedStatus(null));
        }
    });

    async function chooseLocalModel(): Promise<void> {
        setEmbeddedBusy(true);
        setEmbeddedMessage("");
        try {
            const info = await selectAndInspectEmbeddedModel();
            if (!info) return;
            setEmbeddedInfo(info);
            setModel(info.modelId);
            setEmbeddedMessage(
                `${info.name} is ready to load (${Math.round(info.fileSizeBytes / 1024 / 1024)} MB).`,
            );
        } catch (cause) {
            setEmbeddedMessage(errorMessage(cause));
        } finally {
            setEmbeddedBusy(false);
        }
    }

    async function loadLocalModel(): Promise<void> {
        const info = embeddedInfo();
        if (!info) return;
        setEmbeddedBusy(true);
        setEmbeddedMessage("");
        try {
            const status = await loadEmbeddedModel(info.authorizationToken, info.contextTokens, 4);
            setEmbeddedStatus(status);
            setModel(info.modelId);
            setEmbeddedMessage(`${info.name} is loaded locally.`);
        } catch (cause) {
            setEmbeddedMessage(errorMessage(cause));
        } finally {
            setEmbeddedBusy(false);
        }
    }

    function changeProvider(id: string): void {
        setProviderId(id);
        localStorage.setItem("tutorux.ai.provider", id);
        const next = providerById(id);
        const saved = localStorage.getItem(`tutorux.ai.model.${id}`) ?? next.defaultModel;
        setModel(saved);
        setKeyMessage("");
        setConfirmed(false);
        void refreshKey(id);
    }

    async function saveKey(): Promise<void> {
        setError("");
        setKeyMessage("");
        try {
            await saveAiKey(providerId(), keyInput());
            setKeyInput("");
            setKeyPresent(true);
            setKeyMessage("API key saved in the operating system credential store.");
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function removeKey(): Promise<void> {
        setError("");
        try {
            await removeAiKey(providerId());
            setKeyPresent(false);
            setKeyMessage("API key removed.");
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function buildContext(): Promise<{ system: string; user: string }> {
        const selectedTask = TASKS.find((item) => item.id === task())!;
        if (selectedTask.needsSession && !sessionId())
            throw new Error("Choose a session for this task.");
        const chunks: string[] = [];
        if (sessionId()) {
            const detail = await sessionsApi.detail(sessionId());
            chunks.push(`Session: ${detail.session.title}`);
            chunks.push(`Student: ${detail.session.studentName || "Independent"}`);
            chunks.push(`Subject: ${detail.session.subject || "unspecified"}`);
            chunks.push(
                `Date: ${formatDate(detail.session.startedAt ?? detail.session.scheduledAt ?? detail.session.createdAt)}`,
            );
            if (detail.session.notes) chunks.push(`Session notes:\n${detail.session.notes}`);
            if (detail.observations.length) {
                chunks.push(
                    `Observations:\n${detail.observations.map((item) => `- ${item.title || item.kind}: ${item.body}`).join("\n")}`,
                );
            }
            if (detail.cues.length) {
                chunks.push(
                    `Transcript:\n${detail.cues
                        .slice(0, 250)
                        .map((cue) => `- ${cue.speaker ? `${cue.speaker}: ` : ""}${cue.body}`)
                        .join("\n")}`,
                );
            }
            if (detail.materials.length) {
                chunks.push(
                    `Materials:\n${detail.materials.map((item) => `- ${item.title || item.filename}`).join("\n")}`,
                );
            }
        }
        if (studentId()) {
            const detail = await studentsApi.detail(studentId());
            chunks.push(
                `Student profile: ${detail.student.displayName}${detail.student.year ? `, ${detail.student.year}` : ""}`,
            );
            if (detail.student.goals.length)
                chunks.push(`Profile goals: ${detail.student.goals.join("; ")}`);
            if (detail.goals.length)
                chunks.push(
                    `Tracked goals:\n${detail.goals.map((goal) => `- ${goal.title} (${goal.status})`).join("\n")}`,
                );
            if (detail.skills.length)
                chunks.push(
                    `Skill ratings:\n${detail.skills.map((skill) => `- ${skill.skill}: ${skill.rating}/5 ${skill.note}`).join("\n")}`,
                );
            if (detail.evidence.length)
                chunks.push(
                    `Evidence:\n${detail.evidence
                        .slice(0, 40)
                        .map((item) => `- ${item.statement}`)
                        .join("\n")}`,
                );
        }
        if (task() === "chat" && question().trim())
            chunks.push(`Tutor's question: ${question().trim()}`);
        return {
            system: "You are a careful, practical tutoring assistant. Use only the context provided. Do not invent student details. Keep language clear and sentence case.",
            user: `${taskPrompt(task())}\n\nCONTEXT\n${chunks.join("\n\n")}`,
        };
    }

    async function send(): Promise<void> {
        setError("");
        setMessage("");
        setResponse("");
        setSending(true);
        try {
            if (provider().keyRequired && !keyPresent())
                throw new Error("Save an API key for this provider first.");
            if (provider().protocol === "embedded" && !embeddedStatus()?.loaded)
                throw new Error("Choose and load a local GGUF model first.");
            if (!confirmed()) throw new Error("Review and confirm what will be sent.");
            const context = await buildContext();
            const result = await sendAiMessage({
                providerId: providerId(),
                model: model(),
                system: context.system,
                user: context.user,
                onChunk: (text) => setResponse((current) => current + text),
            });
            setResponse(result);
            setMessage("Response complete. Nothing was saved automatically.");
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setSending(false);
        }
    }

    async function saveAsGuide(): Promise<void> {
        if (!response().trim()) return;
        setError("");
        try {
            const detail = sessionId() ? await sessionsApi.detail(sessionId()) : null;
            await guidesApi.create({
                studentId: studentId() || detail?.session.studentId || null,
                sessionId: sessionId() || null,
                title: detail ? `${detail.session.title} guide` : "Assistant guide",
                status: "draft",
                body: response(),
                sourceIds: [],
            });
            setMessage("Saved as a study guide.");
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function copyResponse(): Promise<void> {
        await navigator.clipboard.writeText(response());
        setMessage("Response copied.");
    }

    return (
        <div class="mx-auto w-full max-w-[1240px] px-5 py-5 sm:px-7 lg:px-9">
            <PageHeader
                title="Assistant"
                description="Summaries, guides, feedback, quizzes, and next-lesson plans grounded in this workspace."
                actions={
                    <Badge tone="accent">
                        {workspace.simpleMode() ? "Cloud with consent" : "Provider setup visible"}
                    </Badge>
                }
            />
            <Show when={error()}>
                <div class="mb-4">
                    <InlineNotice tone="danger">{error()}</InlineNotice>
                </div>
            </Show>
            <Show when={message()}>
                <div class="mb-4">
                    <InlineNotice tone="success">{message()}</InlineNotice>
                </div>
            </Show>
            <div class="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                <div class="grid content-start gap-4">
                    <Panel>
                        <PanelHeader title="What should the assistant do?" />
                        <div class="grid gap-2 p-4 sm:grid-cols-2">
                            <For each={TASKS}>
                                {(item) => (
                                    <button
                                        type="button"
                                        class={
                                            item.id === task()
                                                ? "rounded-[5px] border border-accent bg-accent-soft p-3 text-left"
                                                : "rounded-[5px] border border-line bg-surface p-3 text-left hover:bg-surface-inset"
                                        }
                                        onClick={() => setTask(item.id)}
                                    >
                                        <strong class="block text-xs font-medium text-ink">
                                            {item.label}
                                        </strong>
                                        <span class="mt-0.5 block text-[11px] leading-relaxed text-muted">
                                            {item.description}
                                        </span>
                                    </button>
                                )}
                            </For>
                        </div>
                    </Panel>
                    <Panel>
                        <PanelHeader
                            title="Context"
                            detail={
                                task() === "chat"
                                    ? "Student context is required."
                                    : "A session is required."
                            }
                        />
                        <div class="grid gap-3 p-4">
                            <Field label="Session">
                                <Select
                                    value={sessionId()}
                                    onChange={(value) => {
                                        setSessionId(value);
                                        const session = sessions()?.find(
                                            (item) => item.id === value,
                                        );
                                        if (session?.studentId) setStudentId(session.studentId);
                                    }}
                                    ariaLabel="Session"
                                    options={[
                                        { value: "", label: "Choose a session" },
                                        ...(sessions() ?? []).map((session) => ({
                                            value: session.id,
                                            label: `${session.title} · ${formatDate(session.startedAt ?? session.scheduledAt)}`,
                                        })),
                                    ]}
                                />
                            </Field>
                            <Field label="Student">
                                <Select
                                    value={studentId()}
                                    onChange={setStudentId}
                                    ariaLabel="Student"
                                    options={[
                                        { value: "", label: "No student" },
                                        ...(students() ?? []).map((student) => ({
                                            value: student.id,
                                            label: student.displayName,
                                        })),
                                    ]}
                                />
                            </Field>
                            <Show when={task() === "chat"}>
                                <Field label="Question">
                                    <TextArea
                                        value={question()}
                                        onInput={setQuestion}
                                        rows={3}
                                        ariaLabel="Assistant question"
                                    />
                                </Field>
                            </Show>
                        </div>
                    </Panel>
                    <Panel class={workspace.simpleMode() ? "hidden" : undefined}>
                        <PanelHeader
                            title="Provider"
                            detail={
                                workspace.simpleMode()
                                    ? "Cloud AI only sends after confirmation."
                                    : "Keys are stored in the operating system credential store."
                            }
                        />
                        <div class="grid gap-3 p-4">
                            <div class="grid gap-3 sm:grid-cols-2">
                                <Field label="Provider">
                                    <Select
                                        value={providerId()}
                                        onChange={changeProvider}
                                        ariaLabel="AI provider"
                                        options={AI_PROVIDERS.map((item) => ({
                                            value: item.id,
                                            label: item.name,
                                        }))}
                                    />
                                </Field>
                                <Field label="Model">
                                    <TextInput
                                        value={model()}
                                        onInput={(value) => {
                                            setModel(value);
                                            localStorage.setItem(
                                                `tutorux.ai.model.${providerId()}`,
                                                value,
                                            );
                                        }}
                                        ariaLabel="AI model"
                                    />
                                </Field>
                            </div>
                            <Show when={provider().protocol === "embedded"}>
                                <div class="grid gap-2 rounded-[5px] border border-line bg-surface-subtle p-3">
                                    <p class="m-0 text-[11px] leading-relaxed text-muted">
                                        Choose a GGUF model file. It is loaded into this process and
                                        never uploaded.
                                        {embeddedStatus()?.loaded
                                            ? ` Currently loaded: ${embeddedStatus()?.name ?? embeddedStatus()?.modelId}.`
                                            : ""}
                                    </p>
                                    <div class="flex flex-wrap gap-2">
                                        <Button
                                            size="sm"
                                            onClick={() => void chooseLocalModel()}
                                            disabled={embeddedBusy()}
                                        >
                                            Choose model
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="primary"
                                            onClick={() => void loadLocalModel()}
                                            disabled={embeddedBusy() || !embeddedInfo()}
                                        >
                                            Load model
                                        </Button>
                                    </div>
                                    <Show when={embeddedMessage()}>
                                        <p class="m-0 text-[11px] leading-relaxed text-muted">
                                            {embeddedMessage()}
                                        </p>
                                    </Show>
                                </div>
                            </Show>
                            <Show when={provider().keyRequired}>
                                <div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                                    <Field
                                        label="API key"
                                        helper={
                                            keyPresent()
                                                ? "A key is already saved for this provider."
                                                : "The key is stored in the OS credential store, never in the workspace file."
                                        }
                                    >
                                        <TextInput
                                            value={keyInput()}
                                            onInput={setKeyInput}
                                            type="password"
                                            ariaLabel="API key"
                                        />
                                    </Field>
                                    <div class="flex items-end gap-2">
                                        <Button
                                            size="sm"
                                            onClick={() => void saveKey()}
                                            disabled={!keyInput()}
                                        >
                                            Save key
                                        </Button>
                                        <Show when={keyPresent()}>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => void removeKey()}
                                            >
                                                Remove
                                            </Button>
                                        </Show>
                                    </div>
                                </div>
                            </Show>
                            <Show when={keyMessage()}>
                                <InlineNotice tone="success">{keyMessage()}</InlineNotice>
                            </Show>
                        </div>
                    </Panel>
                    <Show when={workspace.simpleMode()}>
                        <Panel>
                            <PanelHeader
                                title="Provider setup"
                                detail="Available in Advanced mode."
                            />
                            <div class="flex flex-wrap items-center justify-between gap-2 p-4 text-xs text-muted">
                                <span>
                                    Switch to Advanced mode to choose a provider, model, or local
                                    GGUF file.
                                </span>
                                <Button size="sm" onClick={() => workspace.setSimpleMode(false)}>
                                    Open Advanced
                                </Button>
                            </div>
                        </Panel>
                    </Show>
                </div>
                <div class="grid content-start gap-4">
                    <Panel>
                        <PanelHeader
                            title="Review before sending"
                            detail="Cloud requests leave this device only after you confirm."
                        />
                        <div class="grid gap-3 p-4">
                            <Button size="sm" onClick={() => setPreview((value) => !value)}>
                                {preview() ? "Hide request preview" : "Show request preview"}
                            </Button>
                            <Show when={preview()}>
                                <pre class="max-h-40 overflow-auto whitespace-pre-wrap rounded-[5px] border border-line bg-surface-subtle p-2 text-[11px] leading-relaxed text-muted">
                                    The request includes the selected session's notes, observations,
                                    transcript highlights, materials, and student goals. It is sent
                                    to {provider().name} at {provider().baseEndpoint}.
                                </pre>
                            </Show>
                            <label class="flex items-start gap-2 text-xs leading-relaxed text-ink-soft">
                                <input
                                    type="checkbox"
                                    class="mt-0.5"
                                    checked={confirmed()}
                                    onChange={(event) => setConfirmed(event.currentTarget.checked)}
                                />
                                <span>
                                    I reviewed the context and want to send it to {provider().name}.
                                </span>
                            </label>
                            <div class="flex flex-wrap items-center gap-2">
                                <Button
                                    variant="primary"
                                    disabled={sending() || !confirmed()}
                                    onClick={() => void send()}
                                >
                                    {sending() ? "Thinking…" : "Send request"}
                                </Button>
                                <Button onClick={() => void copyResponse()} disabled={!response()}>
                                    Copy response
                                </Button>
                                <Button onClick={() => void saveAsGuide()} disabled={!response()}>
                                    Save as guide
                                </Button>
                            </div>
                        </div>
                    </Panel>
                    <Panel class="min-h-[360px]">
                        <PanelHeader
                            title="Response"
                            detail={
                                sending()
                                    ? "Streaming from the provider…"
                                    : response()
                                      ? "Review before saving."
                                      : "Nothing sent yet."
                            }
                        />
                        <Show
                            when={response()}
                            fallback={
                                <div class="p-4 text-xs leading-relaxed text-muted">
                                    Choose a task, review the context, and send. The response
                                    appears here without changing the workspace.
                                </div>
                            }
                        >
                            <pre class="max-h-[58vh] overflow-auto whitespace-pre-wrap p-4 text-xs leading-relaxed text-ink-soft">
                                {response()}
                            </pre>
                        </Show>
                    </Panel>
                    <Show when={sessionId()}>
                        <Button
                            size="sm"
                            onClick={() => navigate(sessionPath(sessionId(), "overview"))}
                        >
                            Open the session
                        </Button>
                    </Show>
                </div>
            </div>
        </div>
    );
}
