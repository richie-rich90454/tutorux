"use strict";

class TutoruxPcmRecorder extends AudioWorkletProcessor {
    constructor() {
        super();
        this.capacity = 4096;
        this.samples = new Int16Array(this.capacity);
        this.length = 0;
        this.flushing = false;
        this.port.onmessage = (event) => {
            if (event.data?.type !== "flush" || this.flushing) return;
            this.flushing = true;
            this.sendSamples();
            this.port.postMessage({ type: "flushed" });
        };
    }

    sendSamples() {
        if (this.length === 0) return;
        const samples = this.samples.slice(0, this.length);
        this.port.postMessage({ type: "pcm", samples: samples.buffer }, [samples.buffer]);
        this.samples = new Int16Array(this.capacity);
        this.length = 0;
    }

    process(inputs, outputs) {
        for (const channel of outputs[0] || []) channel.fill(0);
        if (this.flushing) return false;

        const input = inputs[0] || [];
        const frameCount = input[0]?.length || 0;
        if (frameCount === 0) return true;
        for (let frame = 0; frame < frameCount; frame += 1) {
            let mixedSample = 0;
            for (const channel of input) mixedSample += channel[frame] || 0;
            mixedSample /= input.length;
            const boundedSample = Math.max(-1, Math.min(1, mixedSample));
            this.samples[this.length] = boundedSample < 0
                ? Math.round(boundedSample * 32768)
                : Math.round(boundedSample * 32767);
            this.length += 1;
            if (this.length === this.capacity) this.sendSamples();
        }
        return true;
    }
}

registerProcessor("tutorux-pcm-recorder", TutoruxPcmRecorder);
