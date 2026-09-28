import MidiFile from '../model/MidiFile';
import { BuiltInProfiles, IMusicBoxProfile } from '../model/IMusicBoxProfile';
import { IMusicBoxSvgFormatOptions } from '../model/IMusicBoxSvgFormatOptions';
import MusicBoxSvg from './MusicBoxSvg';

const TPQN = 480;
const SECONDS_PER_TICK = 0.25 / TPQN;

function writeVariableLength(value: number): number[] {
    const bytes = [value & 0x7F];
    let working = value >> 7;
    while (working > 0) {
        bytes.unshift((working & 0x7F) | 0x80);
        working >>= 7;
    }
    return bytes;
}

/** Builds a single-track type 0 MIDI file (one note on/off pair per pitch). */
function buildMidiBuffer(pitches: number[]): ArrayBuffer {
    const track: number[] = [];
    track.push(0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20);
    const name = 'test';
    track.push(0x00, 0xFF, 0x03, name.length);
    name.split('').forEach((c) => track.push(c.charCodeAt(0)));

    pitches.forEach((pitch) => {
        const onTicks = Math.max(1, Math.round(0.5 / SECONDS_PER_TICK));
        const offTicks = Math.max(1, Math.round((onTicks * 0.8) / 1));
        track.push(...writeVariableLength(0), 0x90, pitch, 100);
        track.push(...writeVariableLength(offTicks), 0x80, pitch, 0);
    });
    track.push(0x00, 0xFF, 0x2F, 0x00);

    const header = [0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (TPQN >> 8) & 0xFF, TPQN & 0xFF];
    const length = track.length;
    const trackHeader = [
        0x4D, 0x54, 0x72, 0x6B,
        (length >> 24) & 0xFF, (length >> 16) & 0xFF, (length >> 8) & 0xFF, length & 0xFF,
    ];

    return new Uint8Array([...header, ...trackHeader, ...track]).buffer;
}

const THIRTY_NOTES: number[] = Array.from({ length: 30 }, (_, i) => {
    if (i % 5 === 0) {
        return 36; // out of range, an octave below the lowest supported note
    }
    if (i % 5 === 1) {
        return 96; // out of range, an octave above the highest supported note
    }
    return 60 + (i % 12);
});

const FIFTEEN_NOTES: number[] = [72, 74, 76, 77, 79, 81, 83, 84, 86, 88, 72, 74, 76, 77, 79];

const FORMATTING: IMusicBoxSvgFormatOptions = {
    pageWidthMm: 250,
    pageHeightMm: 200,
    startPaddingMm: 10,
    renderBorder: true,
    omitPageBoundaries: false,
    transposeOutOfRangeNotes: true,
    jigsawJoiners: false,
    loopMode: false,
};

function load(pitches: number[]): MidiFile {
    const midiFile = new MidiFile();
    midiFile.loadFromBuffer(buildMidiBuffer(pitches));
    return midiFile;
}

function createComponent(midiFile: MidiFile, profile: IMusicBoxProfile): MusicBoxSvg {
    return new MusicBoxSvg({
        midiFile: midiFile,
        musicBoxProfile: profile,
        formatting: FORMATTING,
        elementId: 'test-svg',
    });
}

/** The note and absolute time of every hole the component would render. */
function generatedHoles(component: MusicBoxSvg): string[] {
    const pages = (component as any).paginateEvents();
    return pages.flatMap((page: any) =>
        page.midiEvents.map(
            (event: any) => `${event.note}@${event.absTimeSeconds.toFixed(6)}`
        )
    );
}

describe('MusicBoxSvg generation', () => {
    it('leaves the parsed MIDI file untouched while transposing', () => {
        const midiFile = load(THIRTY_NOTES);
        const originalNotes = (midiFile.getTracks()[0].events as any[]).map((e) => e.note);

        createComponent(midiFile, BuiltInProfiles['thirtyNote']).render();
        createComponent(midiFile, BuiltInProfiles['thirtyNote']).render();

        expect((midiFile.getTracks()[0].events as any[]).map((e) => e.note)).toEqual(originalNotes);
        expect(originalNotes).toContain(36);
        expect(originalNotes).toContain(96);
    });

    it('generates the same arrangement no matter which file was loaded before', () => {
        const profile = BuiltInProfiles['thirtyNote'];

        const firstFile = load(THIRTY_NOTES);
        const firstHoles = generatedHoles(createComponent(firstFile, profile));

        // A different, shorter song in between.
        generatedHoles(createComponent(load(FIFTEEN_NOTES), profile));

        // The same song again, and once more from the very first file object.
        const reloadedHoles = generatedHoles(createComponent(load(THIRTY_NOTES), profile));
        const originalFileHoles = generatedHoles(createComponent(firstFile, profile));

        expect(firstHoles.length).toBe(THIRTY_NOTES.length);
        expect(reloadedHoles).toEqual(firstHoles);
        expect(originalFileHoles).toEqual(firstHoles);
    });

    it('regenerates identically when rendering the same file repeatedly', () => {
        const profile = BuiltInProfiles['thirtyNote'];
        const component = createComponent(load(THIRTY_NOTES), profile);

        const first = generatedHoles(component);
        const second = generatedHoles(component);
        const third = generatedHoles(component);

        expect(second).toEqual(first);
        expect(third).toEqual(first);
    });

    it('transposes out of range notes by default and drops them when disabled', () => {
        const profile = BuiltInProfiles['thirtyNote'];
        const midiFile = load(THIRTY_NOTES);

        const transposing = generatedHoles(createComponent(midiFile, profile));
        expect(transposing).toContain('48@0.000000');
        expect(transposing.some((hole) => hole.startsWith('36@'))).toBe(false);
        expect(transposing.some((hole) => hole.startsWith('96@'))).toBe(false);

        const noTransposeOptions: IMusicBoxSvgFormatOptions = {
            ...FORMATTING,
            transposeOutOfRangeNotes: false,
        };
        const plain = new MusicBoxSvg({
            midiFile: midiFile,
            musicBoxProfile: profile,
            formatting: noTransposeOptions,
            elementId: 'test-svg',
        });
        const untouched = generatedHoles(plain);
        expect(untouched.length).toBeLessThan(THIRTY_NOTES.length);
        expect(untouched.every((hole) => profile.supportedNotes.includes(Number(hole.split('@')[0])))).toBe(true);
    });
    it('regenerates a previous file from its original notes when options change', () => {
        const profile = BuiltInProfiles['thirtyNote'];
        const midiFile = load(THIRTY_NOTES);

        const transposing = generatedHoles(createComponent(midiFile, profile));
        expect(transposing.length).toBe(THIRTY_NOTES.length);

        // Turning transposition off after having generated once must reveal the
        // original out of range notes, not the ones already transposed.
        const plain = new MusicBoxSvg({
            midiFile: midiFile,
            musicBoxProfile: profile,
            formatting: { ...FORMATTING, transposeOutOfRangeNotes: false },
            elementId: 'test-svg',
        });
        const regenerated = generatedHoles(plain);

        expect(regenerated.length).toBeLessThan(transposing.length);
        expect(regenerated).not.toEqual(transposing);
    });

    it('drops the pages of a previously loaded file when a new one arrives', () => {
        const profile = BuiltInProfiles['thirtyNote'];
        const firstFile = load(THIRTY_NOTES);
        const component = createComponent(firstFile, profile);
        component.render();
        const numPages = component.getNumPages();
        expect(numPages).toBeGreaterThan(0);

        // Leftovers from the previous file must not be reachable any more.
        (component as any).svgRefs = ['pagina vieja 1', 'pagina vieja 2'];
        component.componentDidUpdate({
            ...component.props,
            midiFile: load(FIFTEEN_NOTES),
        });

        expect(component.getNumPages()).toBe(0);
        expect(component.getSvg(0)).toBeNull();
        expect(component.getSvg(1)).toBeNull();
    });
});

describe('MidiFile reloading', () => {
    it('discards everything parsed from a previously loaded file', () => {
        const midiFile = new MidiFile();
        midiFile.loadFromBuffer(buildMidiBuffer(THIRTY_NOTES));
        expect(midiFile.getTracks().length).toBe(1);
        expect(midiFile.midiStats.noteHistogram.size).toBeGreaterThan(1);

        midiFile.loadFromBuffer(buildMidiBuffer(FIFTEEN_NOTES));

        expect(midiFile.getTracks().length).toBe(1);
        expect(midiFile.chunks.length).toBe(2);
        // Two events per note, plus the tempo, track name and end of track events.
        expect((midiFile.getTracks()[0].events as any[]).length).toBe(FIFTEEN_NOTES.length * 2 + 3);
        expect(midiFile.midiStats.lowNote).toBe(Math.min(...FIFTEEN_NOTES));
        expect(midiFile.midiStats.highNote).toBe(Math.max(...FIFTEEN_NOTES));
    });
});
