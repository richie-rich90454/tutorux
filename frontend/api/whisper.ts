import { invoke } from "@tauri-apps/api/core";

export const WHISPER_LANGUAGES: Array<{ code: string; label: string }> = [
    { code: "auto", label: "Auto-detect" },
    { code: "en", label: "English" },
    { code: "es", label: "Spanish" },
    { code: "fr", label: "French" },
    { code: "de", label: "German" },
    { code: "it", label: "Italian" },
    { code: "pt", label: "Portuguese" },
    { code: "nl", label: "Dutch" },
    { code: "sv", label: "Swedish" },
    { code: "no", label: "Norwegian" },
    { code: "da", label: "Danish" },
    { code: "fi", label: "Finnish" },
    { code: "pl", label: "Polish" },
    { code: "cs", label: "Czech" },
    { code: "sk", label: "Slovak" },
    { code: "hu", label: "Hungarian" },
    { code: "ro", label: "Romanian" },
    { code: "bg", label: "Bulgarian" },
    { code: "hr", label: "Croatian" },
    { code: "sl", label: "Slovenian" },
    { code: "sr", label: "Serbian" },
    { code: "uk", label: "Ukrainian" },
    { code: "ru", label: "Russian" },
    { code: "be", label: "Belarusian" },
    { code: "tr", label: "Turkish" },
    { code: "el", label: "Greek" },
    { code: "he", label: "Hebrew" },
    { code: "ar", label: "Arabic" },
    { code: "fa", label: "Persian" },
    { code: "ur", label: "Urdu" },
    { code: "hi", label: "Hindi" },
    { code: "bn", label: "Bengali" },
    { code: "ta", label: "Tamil" },
    { code: "te", label: "Telugu" },
    { code: "ml", label: "Malayalam" },
    { code: "kn", label: "Kannada" },
    { code: "mr", label: "Marathi" },
    { code: "gu", label: "Gujarati" },
    { code: "pa", label: "Punjabi" },
    { code: "ne", label: "Nepali" },
    { code: "si", label: "Sinhala" },
    { code: "th", label: "Thai" },
    { code: "vi", label: "Vietnamese" },
    { code: "id", label: "Indonesian" },
    { code: "ms", label: "Malay" },
    { code: "tl", label: "Tagalog" },
    { code: "zh", label: "Chinese" },
    { code: "ja", label: "Japanese" },
    { code: "ko", label: "Korean" },
    { code: "yue", label: "Cantonese" },
    { code: "sw", label: "Swahili" },
    { code: "am", label: "Amharic" },
    { code: "so", label: "Somali" },
    { code: "ha", label: "Hausa" },
    { code: "yo", label: "Yoruba" },
    { code: "ig", label: "Igbo" },
    { code: "zu", label: "Zulu" },
    { code: "af", label: "Afrikaans" },
    { code: "ca", label: "Catalan" },
    { code: "gl", label: "Galician" },
    { code: "eu", label: "Basque" },
    { code: "is", label: "Icelandic" },
    { code: "lt", label: "Lithuanian" },
    { code: "lv", label: "Latvian" },
    { code: "et", label: "Estonian" },
    { code: "az", label: "Azerbaijani" },
    { code: "kk", label: "Kazakh" },
    { code: "uz", label: "Uzbek" },
    { code: "hy", label: "Armenian" },
    { code: "ka", label: "Georgian" },
    { code: "la", label: "Latin" },
    { code: "lb", label: "Luxembourgish" },
    { code: "mi", label: "Maori" },
    { code: "cy", label: "Welsh" },
    { code: "mk", label: "Macedonian" },
    { code: "br", label: "Breton" },
    { code: "mn", label: "Mongolian" },
    { code: "bs", label: "Bosnian" },
    { code: "sq", label: "Albanian" },
    { code: "km", label: "Khmer" },
    { code: "sn", label: "Shona" },
    { code: "oc", label: "Occitan" },
    { code: "tg", label: "Tajik" },
    { code: "sd", label: "Sindhi" },
    { code: "yi", label: "Yiddish" },
    { code: "lo", label: "Lao" },
    { code: "fo", label: "Faroese" },
    { code: "ht", label: "Haitian Creole" },
    { code: "ps", label: "Pashto" },
    { code: "tk", label: "Turkmen" },
    { code: "nn", label: "Nynorsk" },
    { code: "mt", label: "Maltese" },
    { code: "sa", label: "Sanskrit" },
    { code: "my", label: "Burmese" },
    { code: "bo", label: "Tibetan" },
    { code: "mg", label: "Malagasy" },
    { code: "as", label: "Assamese" },
    { code: "tt", label: "Tatar" },
    { code: "haw", label: "Hawaiian" },
    { code: "ln", label: "Lingala" },
    { code: "ba", label: "Bashkir" },
    { code: "jw", label: "Javanese" },
    { code: "su", label: "Sundanese" },
];

interface WhisperOutput {
    json: string;
    modelName: string;
}

interface WhisperCue {
    startUs: number;
    endUs: number;
    text: string;
}

export function parseWhisperJson(json: string): WhisperCue[] {
    const parsed = JSON.parse(json) as {
        transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }>;
    };
    return (parsed.transcription ?? [])
        .filter(
            (item) =>
                item.text?.trim() &&
                typeof item.offsets?.from === "number" &&
                typeof item.offsets?.to === "number",
        )
        .map((item) => ({
            startUs: Math.max(0, Number(item.offsets?.from) * 1000),
            endUs: Math.max(0, Number(item.offsets?.to) * 1000),
            text: item.text?.trim() ?? "",
        }))
        .filter((item) => item.endUs > item.startUs);
}

export async function transcribeAudio(audio: Uint8Array, language: string): Promise<WhisperCue[]> {
    const context = new AudioContext({ sampleRate: 16_000 });
    try {
        const decoded = await context.decodeAudioData(audio.slice().buffer as ArrayBuffer);
        const frames = decoded.length;
        const mono = new Float32Array(frames);
        for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
            const source = decoded.getChannelData(channel);
            for (let index = 0; index < frames; index += 1) {
                mono[index] = (mono[index] ?? 0) + (source[index] ?? 0) / decoded.numberOfChannels;
            }
        }
        const samples = new Int16Array(frames);
        for (let index = 0; index < frames; index += 1) {
            const value = Math.max(-1, Math.min(1, mono[index] ?? 0));
            samples[index] = value < 0 ? value * 32768 : value * 32767;
        }
        const wav = new Uint8Array(44 + samples.byteLength);
        const view = new DataView(wav.buffer);
        wav.set(new TextEncoder().encode("RIFF"), 0);
        view.setUint32(4, 36 + samples.byteLength, true);
        wav.set(new TextEncoder().encode("WAVEfmt "), 8);
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, 16_000, true);
        view.setUint32(28, 32_000, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        wav.set(new TextEncoder().encode("data"), 36);
        view.setUint32(40, samples.byteLength, true);
        wav.set(new Uint8Array(samples.buffer), 44);

        const runId = await invoke<string>("begin_whisper_run");
        try {
            const output = await invoke<WhisperOutput>("transcribe_whisper", {
                runId,
                wav: Array.from(wav),
                language: language || "auto",
            });
            return parseWhisperJson(output.json);
        } finally {
            await invoke("end_whisper_run", { runId }).catch(() => undefined);
        }
    } finally {
        await context.close().catch(() => undefined);
    }
}
