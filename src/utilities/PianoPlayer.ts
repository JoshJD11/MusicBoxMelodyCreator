import { IGeneratedMusicBoxEvent } from './MusicBoxMidi';

export type PlaybackState = 'stopped' | 'playing' | 'paused';

/** Notes are scheduled in the audio clock this far ahead of time. */
const PLAYBACK_LOOKAHEAD_SECONDS = 0.5;
const PLAYBACK_SCHEDULE_INTERVAL_MS = 100;

/**
 * Time between pressing play (or continue) and the first moment of the song: enough to schedule the
 * first notes (they are scheduled right away, before the interface updates).
 */
export const START_DELAY_SECONDS = 0.1;

/** Notes still ringing when the line is moved fade out this fast (a sudden stop clicks). */
const SEEK_FADE_SECONDS = 0.015;

/**
 * Gain applied to the mix before the limiter. Measured with the sample songs (offline render):
 * +13 to +16 dB louder than the previous 0.3 without limiter, peaks <= 0.82, no clipping.
 */
export const MASTER_GAIN = 1.0;

/** Limiter that keeps chords from clipping after the gain. */
export const LIMITER = { thresholdDb: -12, kneeDb: 0, ratio: 20, attackSeconds: 0.001, releaseSeconds: 0.1 };

/** Duration of the noise burst at the start of each note (the click of the pluck). */
const NOISE_DURATION_SECONDS = 0.018;

/** A plucked tine sounds at once. */
const ATTACK_SECONDS = 0.002;

/** One note of the sequence, and when it starts in the audio clock. */
interface IScheduledNote {
    startTime: number;
    voice: IPianoVoice;
    /** Played by dragging the line (`scrub`): it rings to its end, whatever the line does next. */
    scrub?: boolean;
}

/** A note to play right away (while the line is dragged). */
export interface IScrubNote {
    note: number;
    velocity: number;
}

/**
 * Plays a sequence of notes with a small synthesizer (Web Audio API) voiced like a music box (the
 * interface still calls it "piano"). The song is played once: at the end it stops by itself.
 * Notes are scheduled a little ahead of time in small batches, so that long songs don't
 * create thousands of audio nodes at once, and each note is disconnected once it has finished.
 *
 * The playback position is the song time (seconds, as in the sequence) heard at the moment: the
 * preview draws the line there. While paused it can be moved (`seek`), and `resume` goes on from
 * the new position.
 */
export default class PianoPlayer {
    private audioContext: AudioContext | null = null;
    private scheduledNotes: IScheduledNote[] = [];
    private output: IOutputChain | null = null;
    private noiseBuffer: AudioBuffer | null = null;

    private pendingEvents: IGeneratedMusicBoxEvent[] = [];
    private pendingIndex = 0;
    /** Audio clock time of song time 0. */
    private startTime = 0;
    private endTime = 0;
    /** Song time where the playback started: the position never goes back before it. */
    private playFrom = 0;
    /** Position chosen while paused (the line was moved); null if it wasn't moved. */
    private seekPosition: number | null = null;

    private completionTimer: number | null = null;
    private scheduleTimer: number | null = null;

    private state: PlaybackState = 'stopped';
    /** Set while an asynchronous transition (play/pause/resume) is running. */
    private busy = false;
    /** Incremented by `stop()`, so that a transition still awaiting the audio device is abandoned. */
    private generation = 0;

    constructor(private onStateChange: (state: PlaybackState) => void) { }

    public getState(): PlaybackState {
        return this.state;
    }

    public static isSupported(): boolean {
        return !!getAudioContextConstructor();
    }

    /**
     * Plays the sequence (stopping anything playing), from the song time `fromSeconds`: the notes
     * before it are skipped, a note exactly there is played.
     */
    public async play(sequence: IGeneratedMusicBoxEvent[], fromSeconds = 0): Promise<void> {
        await this.runExclusive(async () => {
            // The notes the line was just dragged over (stopped) ring to their end.
            this.stopSources(this.state === 'stopped');
            this.seekPosition = null;
            const generation = this.generation;

            const AudioCtor = getAudioContextConstructor();
            if (!sequence.length || !AudioCtor) {
                this.stopSources();
                this.setState('stopped');
                return;
            }

            this.audioContext = this.audioContext ?? new AudioCtor();
            const context = this.audioContext;
            if (context.state === 'suspended') {
                await context.resume();
            }
            if (generation !== this.generation) {
                return; // Stopped while waiting for the audio device.
            }

            this.output = this.output ?? createOutputChain(context);
            this.noiseBuffer = this.noiseBuffer ?? createPianoNoiseBuffer(context);
            this.pendingEvents = sequence;
            this.startFrom(fromSeconds);
            this.setState('playing');
        });
    }

    public async pause(): Promise<void> {
        await this.runExclusive(async () => {
            if (this.state !== 'playing' || !this.audioContext) {
                return;
            }
            this.clearTimers();
            const generation = this.generation;
            // The audio clock stops while suspended, so `endTime` stays valid.
            await this.audioContext.suspend();
            if (generation === this.generation) {
                this.setState('paused');
            }
        });
    }

    /** Goes on after a pause: from where it was, or from where the line was moved (`seek`). */
    public async resume(): Promise<void> {
        await this.runExclusive(async () => {
            if (this.state !== 'paused' || !this.audioContext) {
                return;
            }
            const generation = this.generation;
            await this.audioContext.resume();
            if (generation !== this.generation) {
                return;
            }
            if (this.seekPosition !== null) {
                const from = this.seekPosition;
                this.seekPosition = null;
                this.startFrom(from);
            } else {
                this.scheduleEvents();
                this.scheduleCompletion();
            }
            this.setState('playing');
        });
    }

    /**
     * The song time being heard (the line of the preview): null when stopped. While playing it
     * accounts for the audio device's latency, and never goes back before where playback started.
     */
    public getPosition(): number | null {
        const context = this.audioContext;
        if (this.state === 'stopped' || !context) {
            return null;
        }
        if (this.state === 'paused') {
            // The audio clock is stopped while paused (unless the line was moved).
            return this.seekPosition ?? context.currentTime - this.startTime;
        }
        return Math.max(this.playFrom, heardTime(context) - this.startTime);
    }

    /**
     * Moves the playback position while paused (the line was dragged): the notes still ringing fade
     * out, and `resume` plays from `seconds`. Does nothing unless paused.
     */
    public seek(seconds: number): void {
        const context = this.audioContext;
        if (this.state !== 'paused' || this.busy || !context || !Number.isFinite(seconds)) {
            return;
        }
        const now = context.currentTime;
        // Only the song's notes: the ones played by dragging ring to their end (moving the line on
        // must not cut them).
        this.scheduledNotes.forEach(note => {
            if (!note.scrub) {
                fadeOutVoice(note.voice, now);
            }
        });
        this.seekPosition = seconds;
    }

    /**
     * Plays these notes right away, once (the line was dragged over their holes), without changing
     * the playback state. Only when stopped, or paused after the line was moved: a plain pause keeps
     * the song's notes waiting in the stopped audio clock, and they must not sound.
     */
    public async scrub(notes: IScrubNote[]): Promise<void> {
        const AudioCtor = getAudioContextConstructor();
        const allowed = this.state === 'stopped' || (this.state === 'paused' && this.seekPosition !== null);
        if (!notes.length || !allowed || this.busy || !AudioCtor) {
            return;
        }
        this.audioContext = this.audioContext ?? new AudioCtor();
        const context = this.audioContext;
        const generation = this.generation;
        const state = this.state;
        if (context.state === 'suspended') {
            await context.resume();
        }
        if (generation !== this.generation || state !== this.state || this.busy) {
            return; // Played, stopped or paused meanwhile.
        }
        this.output = this.output ?? createOutputChain(context);
        this.noiseBuffer = this.noiseBuffer ?? createPianoNoiseBuffer(context);
        const now = context.currentTime;
        this.releaseFinishedNotes(now);
        notes.forEach(note => this.scheduledNotes.push({
            startTime: now,
            voice: createPianoNote(context, this.output!.input, note.note, now, note.velocity, this.noiseBuffer!),
            scrub: true,
        }));
    }

    /**
     * Replaces the notes of the song that is playing or paused, without moving the playback
     * position (e.g. after deleting holes): the notes that have already started keep sounding, and
     * the following ones are played from the new sequence. Does nothing when stopped.
     *
     * `shiftSeconds`: how much earlier every note of the new sequence is than the same note in the
     * old one (the first holes were deleted and the song now starts later in the file; negative
     * when they are brought back). The playback position stays at the same point of the music.
     */
    public updateSequence(sequence: IGeneratedMusicBoxEvent[], shiftSeconds = 0): void {
        const context = this.audioContext;
        if (this.state === 'stopped' || !context || !this.output) {
            return;
        }
        if (this.seekPosition !== null) {
            // Paused after moving the line: resume() plays the new sequence from that position.
            this.seekPosition -= shiftSeconds;
            this.pendingEvents = sequence;
            return;
        }
        // Song time 0 moves later (or earlier) in the audio clock by the same amount.
        this.startTime += shiftSeconds;
        this.playFrom -= shiftSeconds;
        // While paused the audio clock is stopped, so this is the paused position.
        const now = context.currentTime;
        const hasStarted = (startTime: number) => startTime <= now;

        // The notes scheduled ahead of time that have not started yet are cancelled...
        this.scheduledNotes = this.scheduledNotes.filter(note => {
            if (hasStarted(note.startTime)) {
                return true;
            }
            releaseVoice(note.voice);
            return false;
        });

        // ...and every note that has not started yet comes from the new sequence.
        this.pendingEvents = sequence;
        this.pendingIndex = 0;
        while (this.pendingIndex < sequence.length && hasStarted(this.startTime + sequence[this.pendingIndex].startTimeSeconds)) {
            this.pendingIndex++;
        }
        this.endTime = Math.max(now, this.startTime + getPlaybackDuration(sequence));

        // When paused (or while pausing or resuming), resume() schedules the notes and the end.
        if (this.state === 'playing' && !this.busy) {
            this.clearTimers();
            this.scheduleEvents();
            this.scheduleCompletion();
        }
    }

    /** Stops playback immediately. */
    public stop(): void {
        this.generation++;
        this.stopSources();
        this.seekPosition = null;
        this.setState('stopped');
    }

    /** Stops playback and releases the audio device. */
    public dispose(): void {
        this.generation++;
        this.stopSources();
        this.seekPosition = null;
        if (this.audioContext) {
            this.audioContext.close().catch(() => undefined);
            this.audioContext = null;
        }
        this.state = 'stopped';
    }

    private async runExclusive(action: () => Promise<void>): Promise<void> {
        if (this.busy) {
            return;
        }
        this.busy = true;
        try {
            await action();
        } finally {
            this.busy = false;
        }
    }

    private setState(state: PlaybackState) {
        if (this.state !== state) {
            this.state = state;
            this.onStateChange(state);
        }
    }

    /** Starts the pending events from the song time `from`, START_DELAY_SECONDS from now. */
    private startFrom(from: number): void {
        const context = this.audioContext!;
        const events = this.pendingEvents;
        this.playFrom = from;
        this.startTime = context.currentTime + START_DELAY_SECONDS - from;
        this.pendingIndex = 0;
        while (this.pendingIndex < events.length && events[this.pendingIndex].startTimeSeconds < from) {
            this.pendingIndex++;
        }
        this.endTime = Math.max(context.currentTime + START_DELAY_SECONDS, this.startTime + getPlaybackDuration(events));
        this.scheduleEvents();
        this.scheduleCompletion();
    }

    private scheduleEvents(): void {
        const context = this.audioContext;
        if (!context || !this.output || !this.noiseBuffer) {
            return;
        }

        this.releaseFinishedNotes(context.currentTime);

        const scheduleUntil = context.currentTime - this.startTime + PLAYBACK_LOOKAHEAD_SECONDS;

        while (
            this.pendingIndex < this.pendingEvents.length &&
            this.pendingEvents[this.pendingIndex].startTimeSeconds <= scheduleUntil
        ) {
            const event = this.pendingEvents[this.pendingIndex];
            const startTime = this.startTime + event.startTimeSeconds;
            this.scheduledNotes.push({
                startTime,
                voice: createPianoNote(context, this.output.input, event.note, startTime, event.velocity, this.noiseBuffer),
            });
            this.pendingIndex++;
        }

        this.scheduleTimer = this.pendingIndex < this.pendingEvents.length
            ? window.setTimeout(() => this.scheduleEvents(), PLAYBACK_SCHEDULE_INTERVAL_MS)
            : null;
    }

    private scheduleCompletion(): void {
        const context = this.audioContext;
        if (!context) {
            return;
        }
        const delaySeconds = this.endTime - context.currentTime;
        this.completionTimer = window.setTimeout(() => {
            this.completionTimer = null;
            this.stop();
        }, Math.max(0, delaySeconds * 1000));
    }

    private clearTimers() {
        if (this.completionTimer !== null) {
            window.clearTimeout(this.completionTimer);
            this.completionTimer = null;
        }
        if (this.scheduleTimer !== null) {
            window.clearTimeout(this.scheduleTimer);
            this.scheduleTimer = null;
        }
    }

    /**
     * Disconnects the notes that have finished ringing. Without this, every note of the song stayed
     * connected to the mix until the end: the audio thread kept processing thousands of silent
     * nodes, more and more as the song went on, until it couldn't keep up (crackling, first on
     * phones). Measured in Chrome with a dense song: from 10% to 71% of the audio thread's capacity
     * after 2 minutes, with the same number of notes ringing; with this, it stays at 12-15%.
     */
    private releaseFinishedNotes(now: number): void {
        this.scheduledNotes = this.scheduledNotes.filter(note => {
            if (note.voice.endTime > now) {
                return true;
            }
            releaseVoice(note.voice);
            return false;
        });
    }

    /**
     * Silences and disconnects every note. With `keepScrub`, the notes played by dragging the line
     * keep ringing (and the mix they go through stays).
     */
    private stopSources(keepScrub = false): void {
        this.clearTimers();

        const kept = keepScrub ? this.scheduledNotes.filter(note => note.scrub) : [];
        this.scheduledNotes.forEach(note => {
            if (!kept.includes(note)) {
                releaseVoice(note.voice);
            }
        });
        this.scheduledNotes = kept;

        if (this.output && kept.length === 0) {
            this.output.disconnect();
            this.output = null;
            this.noiseBuffer = null;
        }

        this.pendingEvents = [];
        this.pendingIndex = 0;
    }
}

/**
 * The audio clock time being heard now: the device plays the audio a little after it is computed
 * (`currentTime`). Uses the output timestamp when the browser provides it.
 */
function heardTime(context: AudioContext): number {
    const stamp = typeof context.getOutputTimestamp === 'function' ? context.getOutputTimestamp() : null;
    if (stamp && stamp.contextTime !== undefined && stamp.performanceTime !== undefined && stamp.performanceTime > 0 &&
        typeof performance !== 'undefined') {
        const elapsed = Math.max(0, (performance.now() - stamp.performanceTime) / 1000);
        return Math.min(context.currentTime, stamp.contextTime + elapsed);
    }
    return context.currentTime;
}

/** Fades a note out from `now` (or makes sure it never starts) and ends it. */
function fadeOutVoice(voice: IPianoVoice, now: number): void {
    if (voice.endTime <= now + SEEK_FADE_SECONDS) {
        return; // Finished, or already fading.
    }
    const gain = voice.output.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(1, now);
    gain.linearRampToValueAtTime(0, now + SEEK_FADE_SECONDS);
    voice.sources.forEach(source => {
        try {
            source.stop(now + SEEK_FADE_SECONDS);
        } catch {
            // Already finished.
        }
    });
    voice.endTime = now + SEEK_FADE_SECONDS;
}

/** Silences a note (if it hasn't finished) and disconnects all its nodes from the mix. */
function releaseVoice(voice: IPianoVoice): void {
    voice.sources.forEach((source) => {
        try {
            source.stop();
        } catch {
            // A source may already have finished naturally.
        }
    });
    voice.nodes.forEach(node => node.disconnect());
}

/** Time from the start of the sequence until its last note has finished ringing. */
function getPlaybackDuration(sequence: IGeneratedMusicBoxEvent[]): number {
    return sequence.reduce(
        (duration, event) => Math.max(duration, event.startTimeSeconds + getPianoReleaseSeconds(event.note) + 0.05),
        0
    );
}

function getAudioContextConstructor(): (new () => AudioContext) | undefined {
    if (typeof window === 'undefined') {
        return undefined;
    }
    // Older Safari versions only provide the prefixed constructor.
    const w = window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
    };
    return w.AudioContext || w.webkitAudioContext;
}

function midiToFrequency(midiNumber: number): number {
    return 440 * Math.pow(2, (midiNumber - 69) / 12);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** Decay of the fundamental: lower notes ring longer. */
function getBaseDecaySeconds(midiNote: number): number {
    return clamp(2.6 - (midiNote - 60) * 0.032, 0.5, 4.5);
}

/** How long a note rings (attack + decay of its fundamental). */
export function getPianoReleaseSeconds(midiNote: number): number {
    return Math.max(0.18, getBaseDecaySeconds(midiNote)) + ATTACK_SECONDS;
}

/**
 * Voiced like the comb of a music box. Each tine is a steel bar clamped at one end and plucked by a
 * pin: an almost pure tone that rings (sine waves, with a little of the 2nd and 3rd harmonics so
 * that low notes are still heard on small speakers), plus the bar's first overtone, which is not a
 * harmonic (6.27 times the fundamental for an ideal bar) and fades almost at once: the bright
 * "ting" of the pluck.
 */
const PARTIALS: Array<{ mult: number; amp: number; decayScale: number }> = [
    { mult: 1, amp: 1.0, decayScale: 1.0 },
    { mult: 2, amp: 0.25, decayScale: 0.6 },
    { mult: 3, amp: 0.08, decayScale: 0.4 },
    { mult: 6.27, amp: 0.3, decayScale: 0.15 },
];

export interface IOutputChain {
    /** Node the notes connect to. */
    input: AudioNode;
    disconnect(): void;
}

/** Mix bus: master gain -> limiter -> speakers. */
export function createOutputChain(context: BaseAudioContext): IOutputChain {
    const gain = context.createGain();
    gain.gain.value = MASTER_GAIN;

    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = LIMITER.thresholdDb;
    limiter.knee.value = LIMITER.kneeDb;
    limiter.ratio.value = LIMITER.ratio;
    limiter.attack.value = LIMITER.attackSeconds;
    limiter.release.value = LIMITER.releaseSeconds;

    gain.connect(limiter);
    limiter.connect(context.destination);
    return {
        input: gain,
        disconnect: () => {
            gain.disconnect();
            limiter.disconnect();
        },
    };
}

/** The audio nodes of one note. */
export interface IPianoVoice {
    /** Its oscillators and noise burst. */
    sources: AudioScheduledSourceNode[];
    /** Every node of the note (sources included), to disconnect it from the mix. */
    nodes: AudioNode[];
    /** The note's own volume (1), to fade it out. */
    output: GainNode;
    /** When the note has stopped sounding, in the audio clock. */
    endTime: number;
}

export function createPianoNote(
    context: BaseAudioContext,
    destination: AudioNode,
    midiNote: number,
    startTime: number,
    velocity: number,
    noiseBuffer: AudioBuffer
): IPianoVoice {
    const fundamental = midiToFrequency(midiNote);
    const velocityGain = 0.18 + 0.6 * (velocity / 127);
    const baseDecay = getBaseDecaySeconds(midiNote);

    const noteGain = context.createGain();
    noteGain.gain.value = 1;
    noteGain.connect(destination);

    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [noteGain];
    let endTime = startTime;

    PARTIALS.forEach((partial) => {
        const frequency = fundamental * partial.mult;
        if (frequency >= context.sampleRate / 2) {
            return; // Above what the audio device can reproduce.
        }
        const osc = context.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(frequency, startTime);

        const partialGain = context.createGain();
        const decay = Math.max(0.18, baseDecay * partial.decayScale);
        const peak = velocityGain * partial.amp * 0.45;

        partialGain.gain.setValueAtTime(0.0001, startTime);
        partialGain.gain.exponentialRampToValueAtTime(peak, startTime + ATTACK_SECONDS);
        partialGain.gain.exponentialRampToValueAtTime(0.0001, startTime + ATTACK_SECONDS + decay);

        osc.connect(partialGain);
        partialGain.connect(noteGain);

        const stopTime = startTime + ATTACK_SECONDS + decay + 0.05;
        osc.start(startTime);
        osc.stop(stopTime);
        sources.push(osc);
        nodes.push(osc, partialGain);
        endTime = Math.max(endTime, stopTime);
    });

    // Short bandpass-filtered noise burst approximating the click of the pluck.
    const noiseSource = context.createBufferSource();
    noiseSource.buffer = noiseBuffer;

    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(clamp(fundamental * 2.5, 400, 8000), startTime);
    noiseFilter.Q.value = 0.6;

    const noiseGain = context.createGain();
    noiseGain.gain.setValueAtTime(velocityGain * 0.1, startTime);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, startTime + NOISE_DURATION_SECONDS);

    noiseSource.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(noteGain);
    const noiseStopTime = startTime + NOISE_DURATION_SECONDS + 0.01;
    noiseSource.start(startTime);
    noiseSource.stop(noiseStopTime);
    sources.push(noiseSource);
    nodes.push(noiseSource, noiseFilter, noiseGain);

    return { sources, nodes, output: noteGain, endTime: Math.max(endTime, noiseStopTime) };
}

export function createPianoNoiseBuffer(context: BaseAudioContext): AudioBuffer {
    const bufferSize = Math.max(1, Math.floor(context.sampleRate * NOISE_DURATION_SECONDS));
    const noiseBuffer = context.createBuffer(1, bufferSize, context.sampleRate);
    const channelData = noiseBuffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
        channelData[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }

    return noiseBuffer;
}
