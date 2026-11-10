import PianoPlayer, { createPianoNote, PlaybackState, START_DELAY_SECONDS } from './PianoPlayer';
import { IGeneratedMusicBoxEvent } from './MusicBoxMidi';
import { FakeAudioContext, fakeAudioContext, FakeParam } from '../testUtils/fakeAudioContext';

/** Every piano note creates 4 oscillators (its partials), the first one at the note's pitch. */
function scheduledNotes() {
    const notes: Array<{ note: number; start: number; stopped: boolean }> = [];
    for (let i = 0; i < fakeAudioContext().oscillators.length; i += 4) {
        const partials = fakeAudioContext().oscillators.slice(i, i + 4);
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
        fakeAudioContext().currentTime += 0.1;
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
        const songStart = START_DELAY_SECONDS; // the song starts a moment after play()
        expect(songStart).toBe(0.1);
        // Scheduled half a second ahead: up to song time 0.4 s.
        expect(audibleNotes(songStart)).toEqual([[60, 0]]);

        advance(1.1); // song position 1.0 s: scheduled up to 1.5 s
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
        const secondStart = fakeAudioContext().currentTime + START_DELAY_SECONDS;
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
        const songStart = START_DELAY_SECONDS;
        advance(1.3); // song position: 1.2 s; notes up to 1.7 s are already scheduled
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
        const songStart = START_DELAY_SECONDS;
        advance(0.8); // song position 0.7 s: 60 and 62 have sounded, 64 (1.0 s) is scheduled

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
        const songStart = START_DELAY_SECONDS;
        advance(0.8); // position 0.7 s of this song (62 and 64 have sounded, 65 at 1.0 s is scheduled)
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
        const songStart = START_DELAY_SECONDS;
        advance(0.8);
        player.updateSequence(SONG);
        advance(10);
        expect(audibleNotes(songStart)).toEqual(SONG.map(e => [e.note, e.startTimeSeconds]));
    });

    it('updates the song while paused: resume continues from the same point with the new notes', async () => {
        await player.play(SONG);
        const songStart = START_DELAY_SECONDS;
        advance(0.8); // position 0.7 s; the note at 1.0 s is already scheduled
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
        advance(0.6); // song position 0.5 s
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
        advance(0.8); // position 0.7 s; the note at 1.0 s is already scheduled
        player.updateSequence([]);
        expect(audibleNotes(START_DELAY_SECONDS).map(n => n[0])).toEqual([60, 62]);
        advance(5);
        expect(player.getState()).toBe('stopped');
    });
    it('disconnects every note once it has finished ringing, so long songs do not overload the audio thread', async () => {
        // 60 notes, one every 0.25 s (15 s of song).
        const long = Array.from({ length: 60 }, (_, i) => event(60 + (i % 12), i * 0.25));
        await player.play(long);
        for (const at of [3, 8, 12]) {
            advance(at - fakeAudioContext().currentTime);
            const now = fakeAudioContext().currentTime;
            // Notes (their 4 oscillators) that ended before the last scheduler run (every 0.1 s) are
            // disconnected; those still ringing (or not started yet) are connected.
            for (let i = 0; i < fakeAudioContext().oscillators.length; i += 4) {
                const partials = fakeAudioContext().oscillators.slice(i, i + 4);
                const end = Math.max(...partials.map(o => o.stopAt as number));
                if (end <= now - 0.1) {
                    expect(partials.every(o => o.disconnected)).toBe(true);
                } else if (end > now) {
                    expect(partials.some(o => o.disconnected)).toBe(false);
                }
            }
            expect(fakeAudioContext().oscillators.filter(o => o.disconnected).length).toBeGreaterThan(0);
        }
        // Disconnecting is not silencing: no note was cut short.
        expect(fakeAudioContext().oscillators.every(o => !o.stopped)).toBe(true);
        advance(10);
        expect(player.getState()).toBe('stopped');
        expect(fakeAudioContext().oscillators.every(o => o.disconnected)).toBe(true);
    });

    it('plays from a position (where the line is): earlier notes are skipped, a note exactly there plays', async () => {
        await player.play(SONG, 1.0);
        const songStart = START_DELAY_SECONDS - 1.0; // song time 1.0 s is heard START_DELAY_SECONDS from now
        advance(10);
        expect(audibleNotes(songStart)).toEqual([[64, 1.0], [65, 1.5], [67, 2.0], [69, 2.5]]);
        expect(player.getState()).toBe('stopped');
    });

    it('reports the position heard: null when stopped, never before the start, frozen while paused', async () => {
        expect(player.getPosition()).toBeNull();
        await player.play(SONG, 0.5);
        // During the start delay the line stays at the start instead of going back.
        expect(player.getPosition()).toBe(0.5);
        advance(1.1);
        expect(player.getPosition()).toBeCloseTo(1.5, 9);
        await player.pause();
        expect(player.getPosition()).toBeCloseTo(1.5, 9);
        vi.advanceTimersByTime(5000);
        expect(player.getPosition()).toBeCloseTo(1.5, 9);
        await player.resume();
        advance(0.5);
        expect(player.getPosition()).toBeCloseTo(2.0, 9);
        player.stop();
        expect(player.getPosition()).toBeNull();
    });

    it('accounts for the latency of the audio device (the line shows what is heard, not what is computed)', async () => {
        await player.play(SONG);
        advance(1.1); // computed: song time 1.0 s
        fakeAudioContext().outputLatency = 0.04;
        expect(player.getPosition()).toBeCloseTo(0.96, 2);
        fakeAudioContext().outputLatency = null;
        expect(player.getPosition()).toBeCloseTo(1.0, 9);
    });

    it('moving the line while paused: the notes ringing fade out, the next ones never play, and resume goes on from there', async () => {
        await player.play(SONG);
        const songStart = START_DELAY_SECONDS;
        advance(0.8); // position 0.7 s: 60 and 62 ring, 64 (1.0 s) is already scheduled
        await player.pause();
        const before = fakeAudioContext().oscillators.slice();
        const now = fakeAudioContext().currentTime;

        player.seek(2.0);
        expect(player.getState()).toBe('paused');
        expect(player.getPosition()).toBe(2.0);
        // Everything scheduled before ends within the fade (64 is stopped before it starts: silent).
        before.forEach(o => expect(o.stopAt as number).toBeLessThanOrEqual(now + 0.015 + 1e-9));
        expect(audibleNotes(songStart)).toEqual([[60, 0], [62, 0.5]]);
        // Their volume fades to 0 instead of stopping at once (a click).
        const fades = fakeAudioContext().nodes.filter(n => (n as unknown as { gain?: FakeParam }).gain?.linearRamps
            .some(([value, time]) => value === 0 && Math.abs(time - (now + 0.015)) < 1e-9));
        expect(fades.length).toBe(3);

        const resumeAt = fakeAudioContext().currentTime;
        await player.resume();
        advance(10);
        const fromSeek = resumeAt + START_DELAY_SECONDS - 2.0;
        expect(audibleNotes(fromSeek).filter(([, t]) => t >= 2.0)).toEqual([[67, 2.0], [69, 2.5]]);
        // 64 and 65 (between the old position and the new one) never sound.
        expect(audibleNotes(songStart).map(n => n[0])).toEqual([60, 62, 67, 69]);
        expect(player.getState()).toBe('stopped');
    });

    it('the line can be moved back too, and several times: only the last position counts', async () => {
        await player.play(SONG);
        advance(2.2); // position 2.1 s
        await player.pause();
        player.seek(0.2);
        player.seek(0.9);
        const resumeAt = fakeAudioContext().currentTime;
        const before = fakeAudioContext().oscillators.length;
        await player.resume();
        advance(10);
        const fromSeek = resumeAt + START_DELAY_SECONDS - 0.9;
        const replayed = scheduledNotes().slice(before / 4)
            .map(n => [n.note, Math.round((n.start - fromSeek) * 1000) / 1000]);
        expect(replayed).toEqual([[64, 1.0], [65, 1.5], [67, 2.0], [69, 2.5]]);
    });

    it('seek does nothing unless paused', async () => {
        player.seek(1);
        expect(player.getPosition()).toBeNull();
        await player.play(SONG);
        advance(0.6);
        player.seek(2.0);
        expect(player.getPosition()).toBeCloseTo(0.5, 9);
        expect(player.getState()).toBe('playing');
    });

    it('after moving the line, deleting the first holes keeps the same point of the music', async () => {
        await player.play(SONG);
        advance(0.6);
        await player.pause();
        player.seek(1.5); // on 65
        // 60 and 62 are deleted: every note is 1 s earlier.
        player.updateSequence(SONG.slice(2).map(e => ({ ...e, startTimeSeconds: e.startTimeSeconds - 1 })), 1);
        expect(player.getPosition()).toBe(0.5);
        const resumeAt = fakeAudioContext().currentTime;
        const before = fakeAudioContext().oscillators.length;
        await player.resume();
        advance(10);
        const fromSeek = resumeAt + START_DELAY_SECONDS - 0.5;
        const played = scheduledNotes().slice(before / 4).map(n => [n.note, Math.round((n.start - fromSeek) * 1000) / 1000]);
        expect(played).toEqual([[65, 0.5], [67, 1.0], [69, 1.5]]);
    });

    it('plays the notes the line is dragged over at once, without starting the song (stopped)', async () => {
        await player.scrub([{ note: 64, velocity: 100 }, { note: 67, velocity: 90 }]);
        expect(player.getState()).toBe('stopped');
        expect(states).toEqual([]);
        expect(scheduledNotes().map(n => [n.note, n.start])).toEqual([[64, 0], [67, 0]]);
        // Nothing else is scheduled afterwards.
        advance(5);
        expect(scheduledNotes().length).toBe(2);
        // And Play still plays the song from the start.
        await player.play(SONG);
        expect(player.getState()).toBe('playing');
    });

    it('while paused, dragged notes only sound once the line has moved (a plain pause keeps the song waiting)', async () => {
        await player.play(SONG);
        advance(0.8);
        await player.pause();
        const before = fakeAudioContext().oscillators.length;
        await player.scrub([{ note: 72, velocity: 100 }]);
        expect(fakeAudioContext().oscillators.length).toBe(before);
        expect(fakeAudioContext().state).toBe('suspended');

        player.seek(1.2);
        await player.scrub([{ note: 72, velocity: 100 }]);
        expect(fakeAudioContext().state).toBe('running');
        expect(player.getState()).toBe('paused');
        expect(scheduledNotes().slice(before / 4).map(n => [n.note, n.start])).toEqual([[72, fakeAudioContext().currentTime]]);
        // Nothing of the song plays until resume.
        vi.advanceTimersByTime(5000);
        expect(fakeAudioContext().oscillators.length).toBe(before + 4);
    });

    it('does not scrub while playing', async () => {
        await player.play(SONG);
        const before = fakeAudioContext().oscillators.length;
        await player.scrub([{ note: 72, velocity: 100 }]);
        expect(fakeAudioContext().oscillators.length).toBe(before);
    });
    it('notes played by dragging ring to their end: moving the line on does not cut them', async () => {
        await player.play(SONG);
        advance(0.8);
        await player.pause();
        player.seek(0.6);
        const before = fakeAudioContext().oscillators.length;
        await player.scrub([{ note: 72, velocity: 100 }]);
        const scrubbed = fakeAudioContext().oscillators.slice(before);
        const naturalEnds = scrubbed.map(o => o.stopAt);
        // The line keeps moving (backwards and forwards): each move is a seek.
        player.seek(0.4);
        player.seek(0.2);
        player.seek(0.9);
        expect(scrubbed.map(o => o.stopAt)).toEqual(naturalEnds);
        expect(scrubbed.every(o => !o.stopped && !o.disconnected)).toBe(true);
        // The fundamental rings for its whole decay (C5: about 2.2 s), not 15 ms.
        expect((scrubbed[0].stopAt as number) - (scrubbed[0].startAt as number)).toBeGreaterThan(2);
        // And resuming the song doesn't cut them either.
        await player.resume();
        expect(scrubbed.map(o => o.stopAt)).toEqual(naturalEnds);
    });

    it('pressing Play right after dragging the line (stopped) does not cut the notes it played', async () => {
        await player.scrub([{ note: 67, velocity: 100 }]);
        const scrubbed = fakeAudioContext().oscillators.slice();
        const naturalEnds = scrubbed.map(o => o.stopAt);
        fakeAudioContext().currentTime = 0.3;
        await player.play(SONG, 1.0);
        expect(scrubbed.map(o => o.stopAt)).toEqual(naturalEnds);
        expect(scrubbed.every(o => !o.disconnected)).toBe(true);
        // A setting change (stop) still silences everything at once.
        player.stop();
        expect(scrubbed.every(o => o.disconnected)).toBe(true);
    });
});
