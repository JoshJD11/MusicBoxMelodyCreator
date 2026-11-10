/**
 * A fake Web Audio context (jsdom has none): records every oscillator with its frequency, start
 * time and whether it was stopped. The audio clock (`currentTime`) is moved by hand. Install it with
 * `vi.stubGlobal('AudioContext', FakeAudioContext)`; `fakeAudioContext()` is the last one created.
 */
export class FakeParam {
    public value = 0;
    /** linearRampToValueAtTime calls, as [value, time]. */
    public linearRamps: Array<[number, number]> = [];
    public setValueAtTime(value: number) { this.value = value; return this; }
    public exponentialRampToValueAtTime() { return this; }
    public linearRampToValueAtTime(value: number, time: number) { this.linearRamps.push([value, time]); return this; }
    public cancelScheduledValues() { return this; }
}

export class FakeNode {
    public disconnected = false;
    constructor() { context?.nodes.push(this); }
    public connect() { return this; }
    public disconnect() { this.disconnected = true; }
}

export class FakeSource extends FakeNode {
    public startAt: number | null = null;
    /** When it ends (its last stop() call). */
    public stopAt: number | null = null;
    /**
     * Stopped before it started: it never sounds. (A note schedules its own end with stop(time); a
     * stop() of a note that is sounding or has finished doesn't make it silent after the fact.)
     */
    public stopped = false;
    public frequency = new FakeParam();
    public type = '';
    public buffer: unknown = null;
    public start(when: number) { this.startAt = when; }
    public stop(when?: number) {
        // Like Web Audio: stop() before start() fails; the player must handle it.
        if (this.startAt === null) {
            throw new Error('InvalidStateError');
        }
        const at = when === undefined ? context.currentTime : when;
        if (at < this.startAt) {
            this.stopped = true;
        }
        this.stopAt = at;
    }
}

let context: FakeAudioContext;

/** The last FakeAudioContext created. */
export function fakeAudioContext(): FakeAudioContext {
    return context;
}

export class FakeAudioContext {
    public currentTime = 0;
    public state: 'running' | 'suspended' | 'closed' = 'running';
    public sampleRate = 44100;
    public destination: FakeNode;
    public oscillators: FakeSource[] = [];
    /** Every node created (to check which ones are still connected). */
    public nodes: FakeNode[] = [];
    /** Set to simulate the latency of the audio device (see getOutputTimestamp). */
    public outputLatency: number | null = null;

    constructor() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        context = this;
        this.destination = new FakeNode();
    }
    public getOutputTimestamp() {
        return this.outputLatency === null
            ? { contextTime: 0, performanceTime: 0 }
            : { contextTime: this.currentTime - this.outputLatency, performanceTime: performance.now() };
    }
    public createGain() { return Object.assign(new FakeNode(), { gain: new FakeParam() }); }
    public createOscillator() {
        const oscillator = new FakeSource();
        this.oscillators.push(oscillator);
        return oscillator;
    }
    public createBufferSource() { return new FakeSource(); }
    public createBiquadFilter() { return Object.assign(new FakeNode(), { type: '', frequency: new FakeParam(), Q: new FakeParam() }); }
    public createDynamicsCompressor() {
        return Object.assign(new FakeNode(), {
            threshold: new FakeParam(), knee: new FakeParam(), ratio: new FakeParam(), attack: new FakeParam(), release: new FakeParam(),
        });
    }
    public createBuffer(_channels: number, length: number) {
        const data = new Float32Array(length);
        return { getChannelData: () => data };
    }
    public resume() { this.state = 'running'; return Promise.resolve(); }
    public suspend() { this.state = 'suspended'; return Promise.resolve(); }
    public close() { this.state = 'closed'; return Promise.resolve(); }
}
