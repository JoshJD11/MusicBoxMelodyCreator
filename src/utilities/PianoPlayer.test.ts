import PianoPlayer, { createPianoNote, PlaybackState } from './PianoPlayer';
import { IGeneratedMusicBoxEvent } from './MusicBoxMidi';

/**
 * A fake Web Audio context (jsdom has none): records every oscillator with its frequency, start
 * time and whether it was stopped. The audio clock (`currentTime`) is moved by hand.
 */
class FakeParam {
    public value = 0;
    public setValueAtTime(value: number) { this.value = value; return this; }
    public exponentialRampToValueAtTime() { return this; }
    public linearRampToValueAtTime() { return this; }
}

class FakeNode {
    public connect() { return this; }
    public disconnect() { /* nothing */ }
}

class FakeSource extends FakeNode {
    public startAt: number | null = null;
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
        if (when === undefined && context.currentTime < this.startAt) {
            this.stopped = true;
        }
    }
}

let context: FakeAudioContext;

class FakeAudioContext {
    public currentTime = 0;
    public state: 'running' | 'suspended' | 'closed' = 'running';
    public sampleRate = 44100;
    public destination = new FakeNode();
    public oscillators: FakeSource[] = [];

    constructor() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        context = this;
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

/** Every piano note creates 4 oscillators (its partials), the first one at the note's pitch. */
function scheduledNotes() {
    const notes: Array<{ note: number; start: number; stopped: boolean }> = [];
    for (let i = 0; i < context.oscillators.length; i += 4) {
        const partials = context.oscillators.slice(i, i + 4);
        notes.push({
            note: Math.round(69 + 12 * Math.log2(partials[0].frequency.value / 440)),
            start: partials[0].startAt as number,
            stopped: partials.every(o => o.stopped),
        });
    }
    return notes;
}

/** Notes that will sound (or did): scheduled and not cancelled, as [note, song time]. */
function audibleNotes(songStart: number) {
    return scheduledNotes()
        .filter(n => !n.stopped)
        .map(n => [n.note, Math.round((n.start - songStart) * 1000) / 1000]);
}

const event = (note: number, startTimeSeconds: number): IGeneratedMusicBoxEvent =>
    ({ note, startTimeSeconds, durationSeconds: 0.3, velocity: 100 });

/** Moves the audio clock and lets the scheduler run as many times as it would meanwhile. */
function advance(seconds: number) {
    const steps = Math.round(seconds / 0.1);
    for (let i = 0; i < steps; i++) {
        context.currentTime += 0.1;
        vi.advanceTimersByTime(100);
    }
}

const SONG = [event(60, 0), event(62, 0.5), event(64, 1.0), event(65, 1.5), event(67, 2.0), event(69, 2.5)];

describe('PianoPlayer', () => {
    let states: PlaybackState[];
    let player: PianoPlayer;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('AudioContext', FakeAudioContext);
        states = [];
        player = new PianoPlayer(state => states.push(state));
    });

    afterEach(() => {
        player.dispose();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('schedules the notes a little ahead of time and stops at the end of the song', async () => {
        await player.play(SONG);
        expect(player.getState()).toBe('playing');
        const songStart = 0.5; // the song starts half a second after play()
        expect(audibleNotes(songStart)).toEqual([[60, 0]]);

        advance(1.5);
        expect(audibleNotes(songStart).map(n => n[0])).toEqual([60, 62, 64, 65]);

        advance(10);
        expect(audibleNotes(songStart)).toEqual(SONG.map(e => [e.note, e.startTimeSeconds]));
        expect(player.getState()).toBe('stopped');
        expect(states).toEqual(['playing', 'stopped']);
    });

    it('plays the song only once: after the end nothing is scheduled until play is pressed again', async () => {
        await player.play(SONG);
        advance(10);
        expect(player.getState()).toBe('stopped');
        const played = scheduledNotes().length;
        expect(played).toBe(SONG.length);

        // Long after the end: still stopped, and no note was scheduled again.
        advance(60);
        expect(scheduledNotes().length).toBe(played);
        expect(states).toEqual(['playing', 'stopped']);

        // Pressing play again plays it once more, from the start.
        const secondStart = context.currentTime + 0.5;
        await player.play(SONG);
        advance(10);
        expect(scheduledNotes().length).toBe(2 * played);
        expect(scheduledNotes().slice(played).map(n => [n.note, Math.round((n.start - secondStart) * 1000) / 1000]))
            .toEqual(SONG.map(e => [e.note, e.startTimeSeconds]));
        expect(player.getState()).toBe('stopped');
    });

    it('voices each note like a music box tine: sine partials, the last one a bright inharmonic overtone', () => {
        const audio = new FakeAudioContext();
        const noise = audio.createBuffer(1, 10);
        createPianoNote(audio as unknown as BaseAudioContext, audio.destination as unknown as AudioNode,
            69, 1, 100, noise as unknown as AudioBuffer);
        expect(audio.oscillators.map(o => o.type)).toEqual(['sine', 'sine', 'sine', 'sine']);
        expect(audio.oscillators.map(o => Math.round(o.frequency.value * 100) / 100)).toEqual([440, 880, 1320, 2758.8]);
        expect(audio.oscillators.every(o => o.startAt === 1)).toBe(true);

        // Partials above half the sample rate (which can't be reproduced) are left out.
        const high = new FakeAudioContext();
        createPianoNote(high as unknown as BaseAudioContext, high.destination as unknown as AudioNode,
            108, 0, 100, noise as unknown as AudioBuffer); // C8: 4186 Hz
        expect(high.oscillators.map(o => Math.round(o.frequency.value))).toEqual([4186, 8372, 12558]);
    });

    it('updates the song while playing without restarting it: started notes keep sounding, the rest come from the new song', async () => {
        await player.play(SONG);
        const songStart = 0.5;
        advance(1.7); // song position: 1.2 s; notes up to 1.7 s are already scheduled
        expect(audibleNotes(songStart).map(n => n[0])).toEqual([60, 62, 64, 65]);

        // 62 (already played) and 65 (scheduled, not started yet) are deleted.
        player.updateSequence(SONG.filter(e => e.note !== 62 && e.note !== 65));
        expect(player.getState()).toBe('playing');
        expect(audibleNotes(songStart)).toEqual([[60, 0], [62, 0.5], [64, 1.0]]);

        advance(10);
        expect(audibleNotes(songStart)).toEqual([[60, 0], [62, 0.5], [64, 1.0], [67, 2.0], [69, 2.5]]);
        // No note was played twice.
        expect(scheduledNotes().filter(n => n.note === 64).length).toBe(1);
        expect(player.getState()).toBe('stopped');
    });

    it('when the first notes are deleted while playing (the song now starts later), it stays at the same point of the music', async () => {
        await player.play(SONG);
        const songStart = 0.5;
        advance(1.2); // song position 0.7 s: 60 and 62 have sounded, 64 (1.0 s) is scheduled

        // 60 and 62 are deleted: the song now starts at 64, so every note is 1 s earlier.
        const shifted = SONG.slice(2).map(e => ({ ...e, startTimeSeconds: e.startTimeSeconds - 1 }));
        player.updateSequence(shifted, 1);
        advance(10);
        // Nothing skipped, nothing played twice: the same notes at the same moments.
        expect(audibleNotes(songStart)).toEqual(SONG.map(e => [e.note, e.startTimeSeconds]));
        expect(scheduledNotes().filter(n => !n.stopped).length).toBe(SONG.length);
        expect(player.getState()).toBe('stopped');
    });

    it('when the first notes come back while paused (undo), resume goes on from the same point of the music', async () => {
        const withoutFirst = SONG.slice(1).map(e => ({ ...e, startTimeSeconds: e.startTimeSeconds - 0.5 }));
        await player.play(withoutFirst); // starts with 62 at 0 s
        const songStart = 0.5;
        advance(1.2); // position 0.7 s of this song (62 and 64 have sounded, 65 at 1.0 s is scheduled)
        await player.pause();

        player.updateSequence(SONG, -0.5);
        await player.resume();
        advance(10);
        // In the restored song, 60 would be at -0.5 s (already past): it is not played.
        expect(audibleNotes(songStart)).toEqual(withoutFirst.map(e => [e.note, e.startTimeSeconds]));
        expect(player.getState()).toBe('stopped');
    });

    it('plays notes added back (undo) if they have not been reached yet', async () => {
        await player.play(SONG.filter(e => e.note !== 67));
        const songStart = 0.5;
        advance(1.2);
        player.updateSequence(SONG);
        advance(10);
        expect(audibleNotes(songStart)).toEqual(SONG.map(e => [e.note, e.startTimeSeconds]));
    });

    it('updates the song while paused: resume continues from the same point with the new notes', async () => {
        await player.play(SONG);
        const songStart = 0.5;
        advance(1.2); // position 0.7 s; the note at 1.0 s is already scheduled
        await player.pause();
        expect(player.getState()).toBe('paused');

        player.updateSequence(SONG.filter(e => e.note !== 64 && e.note !== 67));
        // Nothing is scheduled while paused.
        vi.advanceTimersByTime(5000);
        expect(audibleNotes(songStart)).toEqual([[60, 0], [62, 0.5]]);
        expect(player.getState()).toBe('paused');

        await player.resume();
        advance(10);
        expect(audibleNotes(songStart)).toEqual([[60, 0], [62, 0.5], [65, 1.5], [69, 2.5]]);
        expect(player.getState()).toBe('stopped');
    });

    it('ends earlier when the last notes are deleted', async () => {
        await player.play(SONG);
        advance(1.0);
        player.updateSequence(SONG.slice(0, 2));
        // The last note (62 at 0.5 s) rings for about 2.7 s.
        advance(2.0);
        expect(player.getState()).toBe('playing');
        advance(1.5);
        expect(player.getState()).toBe('stopped');
    });

    it('does nothing when it is not playing', async () => {
        player.updateSequence(SONG);
        expect(player.getState()).toBe('stopped');
        expect(states).toEqual([]);

        await player.play(SONG);
        player.stop();
        const before = scheduledNotes().length;
        player.updateSequence(SONG);
        advance(5);
        expect(scheduledNotes().length).toBe(before);
        expect(player.getState()).toBe('stopped');
    });

    it('can update the song to nothing: what has not started is cancelled and it stops', async () => {
        await player.play(SONG);
        advance(1.2); // position 0.7 s; the note at 1.0 s is already scheduled
        player.updateSequence([]);
        expect(audibleNotes(0.5).map(n => n[0])).toEqual([60, 62]);
        advance(5);
        expect(player.getState()).toBe('stopped');
    });
});
