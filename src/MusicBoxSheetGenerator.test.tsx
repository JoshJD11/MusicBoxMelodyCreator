import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, fireEvent, cleanup, within, wait, act } from '@testing-library/react';
import MusicBoxSheetGenerator from './MusicBoxSheetGenerator';
import MidiFile from './model/MidiFile';
import { BuiltInProfiles } from './model/IMusicBoxProfile';
import { computeMusicBoxLayout, fitSingleStrip, getNoteLinePositions, IMusicBoxLayout } from './utilities/MusicBoxLayout';
import { placeStripLine } from './utilities/SheetDrawing';
import { addedNoteId, IAddedNote } from './utilities/MusicBoxNotes';
import { TOO_CLOSE_REASON } from './utilities/NoteGuides';
import { IMusicBoxSvgFormatOptions } from './model/IMusicBoxSvgFormatOptions';
import { buildMidi, endOfTrack, noteOff, noteOn } from './testUtils/midiBuilder';
import { createDxf } from './utilities/DxfExporter';
import { parseDxf } from './utilities/DxfReader';
import { buildGeneratedMusicBoxSequence } from './utilities/MusicBoxMidi';
import PianoPlayer, { START_DELAY_SECONDS } from './utilities/PianoPlayer';
import { playheadAt } from './utilities/Playhead';
import { FakeAudioContext, fakeAudioContext } from './testUtils/fakeAudioContext';
import { detectNotes } from './utilities/BasicPitchTranscriber';
import {
    DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS,
    detectedNotesToMidi,
    IAudioAnalysis,
    IAudioTranscriptionSettings,
    trimLeadingSilence,
} from './utilities/AudioTranscription';

/**
 * MP3: the browser's decoding and the model's run are replaced (jsdom has neither Web Audio nor
 * WebGL; the real model is tested in BasicPitchTranscriber.test.ts). Basic Pitch's note detection,
 * the MIDI writer and everything after them are the real ones.
 */
const audioMocks = vi.hoisted(() => ({
    decodeError: false,
    analysis: null as unknown as IAudioAnalysis,
    /** If set, the model's run waits for this promise. */
    gate: null as Promise<void> | null,
}));

vi.mock('./utilities/AudioDecoding', () => ({
    decodeAudioFile: async () => {
        if (audioMocks.decodeError) {
            throw new Error('The audio could not be decoded. Make sure the file is a valid MP3.');
        }
        return { samples: new Float32Array(16), durationSeconds: 3 };
    },
}));

vi.mock('./utilities/BasicPitchTranscriber', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./utilities/BasicPitchTranscriber')>();
    return {
        ...actual,
        loadBasicPitchModel: async () => undefined,
        analyzeAudio: async (_samples: Float32Array, onProgress: (fraction: number) => void) => {
            onProgress(0);
            if (audioMocks.gate) {
                await audioMocks.gate;
            }
            onProgress(1);
            return audioMocks.analysis;
        },
    };
});

/** Basic Pitch activations with clear notes: [MIDI note, first frame, length in frames]. */
function activations(notes: [number, number, number][], totalFrames = 260): IAudioAnalysis {
    const frames = Array.from({ length: totalFrames }, () => new Array<number>(88).fill(0));
    const onsets = Array.from({ length: totalFrames }, () => new Array<number>(88).fill(0));
    notes.forEach(([pitch, start, length]) => {
        onsets[start][pitch - 21] = 0.9;
        for (let f = start; f < start + length; f++) {
            frames[f][pitch - 21] = 0.8;
        }
    });
    return { frames, onsets, durationSeconds: totalFrames * 256 / 22050 };
}

/**
 * The MIDI file the app must make from the audio: Basic Pitch's notes, without the silence before
 * the first one, written as MIDI.
 */
function expectedAudioMidi(analysis: IAudioAnalysis, settings: IAudioTranscriptionSettings): MidiFile {
    const midiFile = new MidiFile();
    midiFile.loadFromBuffer(detectedNotesToMidi(trimLeadingSilence(detectNotes(analysis, settings)).notes));
    return midiFile;
}

const SAMPLE = 'You are my sunshine.mid';
const DEFAULT_FORMAT: IMusicBoxSvgFormatOptions = {
    pageWidthMm: 250, pageHeightMm: 200, startPaddingMm: 10, renderBorder: true, omitPageBoundaries: false,
    transposeOutOfRangeNotes: true, includePercussion: false, jigsawJoiners: false, loopMode: false,
    mirrorVertically: false, stripOrientation: 'vertical',
};

function loadSampleMidi(): MidiFile {
    const midiFile = new MidiFile();
    const bytes = sampleBytes();
    midiFile.loadFromBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return midiFile;
}

/** The options the app uses right after loading the sample: sizes fitted to a single strip. */
function fittedFormat(format: IMusicBoxSvgFormatOptions = DEFAULT_FORMAT): IMusicBoxSvgFormatOptions {
    return fitSingleStrip(loadSampleMidi(), BuiltInProfiles['thirtyNote'], format);
}

function sampleBytes(): Uint8Array<ArrayBuffer> {
    // Copy into a plain ArrayBuffer (not shared with Node's Buffer pool).
    return Uint8Array.from(fs.readFileSync(path.resolve(__dirname, '../samples', SAMPLE)));
}

function readBlob(blob: Blob): Promise<string> {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsText(blob);
    });
}

/** The <input> of a Blueprint NumericInput inside its <label>. */
function numericInput(label: HTMLElement): HTMLInputElement {
    return label.closest('label')!.querySelector('input') as HTMLInputElement;
}

function pickFile(container: HTMLElement, file: File) {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.getAttribute('accept')).toContain('.mid');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);
}

describe('MusicBoxSheetGenerator (end to end)', () => {
    const createdBlobs: Blob[] = [];

    beforeEach(() => {
        createdBlobs.length = 0;
        // jsdom does not implement object URLs.
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn((blob: Blob) => {
                createdBlobs.push(blob);
                return 'blob:test-' + createdBlobs.length;
            }),
        });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
        // jsdom does not implement navigation on anchor clicks.
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    it('loads a MIDI file, previews it and downloads exactly the computed DXF sheets', async () => {
        const { container, findByText, getByText } = render(<MusicBoxSheetGenerator />);
        expect(getByText('No MIDI loaded')).toBeTruthy();

        pickFile(container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        await findByText('MIDI ready');

        // Vertical strips by default, on a sheet fitted to the whole song: one strip.
        const format = fittedFormat();
        const layout = computeMusicBoxLayout(loadSampleMidi(), BuiltInProfiles['thirtyNote'], format);
        expect(layout.drawings.length).toBe(1);
        expect(layout.drawings[0].strips.length).toBe(1);

        // The preview shows one SVG per sheet, in a box that scrolls on its own.
        const sheets = container.querySelectorAll('.mb-musicBoxSvgPages-limited .mb-musicBoxSvgWrapper svg');
        expect(sheets.length).toBe(1);
        expect(sheets[0].getAttribute('width')).toBe('70.1mm');
        expect(sheets[0].getAttribute('height')).toBe(format.pageWidthMm + 'mm');
        // Only the holes of the DXF (the playback line and its handles are drawn over them).
        expect(container.querySelectorAll('.mb-musicBoxSvgWrapper circle[stroke="black"]').length).toBe(layout.extraction.notes.length);

        fireEvent.click(getByText('Download DXF(s)'));
        expect(createdBlobs.length).toBe(1);
        const downloaded = await Promise.all(createdBlobs.map(readBlob));
        expect(downloaded).toEqual(layout.drawings.map(createDxf));
        expect(downloaded[0].split('\r\n').slice(18, 24))
            .toEqual(['9', '$EXTMAX', '10', '70.1', '20', String(format.pageWidthMm)]);
    });

    it('can switch to horizontal strips: downloads exactly the computed sheets', async () => {
        const { container, findByText, getByText, getByRole, getByLabelText, queryByText } = render(<MusicBoxSheetGenerator />);
        pickFile(container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        await findByText('MIDI ready');

        fireEvent.click(getByText('Layout/Pagination'));
        const panel = () => within(getByRole('tabpanel'));
        expect((getByLabelText(/Vertical/) as HTMLInputElement).checked).toBe(true);
        expect(panel().getByText('Max strip length / sheet height (mm)')).toBeTruthy();
        expect(panel().getByText('Sheet width (mm)')).toBeTruthy();
        expect(panel().getByText(/lowest note on the right/)).toBeTruthy();

        fireEvent.click(getByLabelText(/Horizontal/));
        // Same fields, named as they are on a sheet with horizontal strips.
        expect(panel().getByText('Max strip length / sheet width (mm)')).toBeTruthy();
        expect(panel().getByText('Sheet height (mm)')).toBeTruthy();
        expect(panel().getByText(/lowest note at the top/)).toBeTruthy();
        expect(getByText(/Settings not applied yet: Layout\/Pagination/)).toBeTruthy();
        fireEvent.click(panel().getAllByText('Apply')[0]);
        expect(queryByText(/Settings not applied yet/)).toBeNull();

        const format: IMusicBoxSvgFormatOptions = { ...fittedFormat(), stripOrientation: 'horizontal' };
        const layout = computeMusicBoxLayout(loadSampleMidi(), BuiltInProfiles['thirtyNote'], format);

        // Horizontal sheets too: the preview is limited in height and scrolls on its own (it follows
        // the playback line without scrolling the page).
        expect(container.querySelector('.mb-musicBoxSvgPages-limited')).not.toBeNull();
        const svgs = container.querySelectorAll('.mb-musicBoxSvgWrapper svg');
        expect(svgs.length).toBe(1);
        expect(svgs[0].getAttribute('width')).toBe(format.pageWidthMm + 'mm');
        expect(svgs[0].getAttribute('height')).toBe('70.1mm');

        createdBlobs.length = 0;
        fireEvent.click(getByText('Download DXF(s)'));
        const downloaded = await Promise.all(createdBlobs.map(readBlob));
        expect(downloaded).toEqual(layout.drawings.map(createDxf));
    });

    it('fits the sizes to the song on every load, even of the same file, keeping other unapplied edits', async () => {
        const { container, findByText, getByText, getByRole } = render(<MusicBoxSheetGenerator />);
        fireEvent.click(getByText('Layout/Pagination'));
        const panel = () => within(getByRole('tabpanel'));
        const lengthInput = () => numericInput(panel().getByText(/Max strip length/));
        const acrossInput = () => numericInput(panel().getByText(/Sheet width/));
        const paddingInput = () => numericInput(panel().getByText(/Start padding/));
        const load = async () => {
            pickFile(container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
            await findByText('MIDI ready');
        };
        expect(lengthInput().value).toBe('250');

        await load();
        const fitted = fittedFormat();
        expect(lengthInput().value).toBe(String(fitted.pageWidthMm));
        expect(acrossInput().value).toBe('70.1');

        // My own sizes are used until the next load...
        fireEvent.change(lengthInput(), { target: { value: '190' } });
        fireEvent.change(acrossInput(), { target: { value: '200' } });
        fireEvent.click(panel().getAllByText('Apply')[0]);
        expect(container.querySelectorAll('.mb-musicBoxSvgWrapper svg')[0].getAttribute('height')).toBe('190mm');

        // ... which fits them again; an unapplied edit of another field is kept.
        fireEvent.change(paddingInput(), { target: { value: '3' } });
        await load();
        expect(lengthInput().value).toBe(String(fitted.pageWidthMm));
        expect(acrossInput().value).toBe('70.1');
        expect(paddingInput().value).toBe('3');
        expect(panel().getByText('Changes not applied yet')).toBeTruthy();
        expect(container.querySelectorAll('.mb-musicBoxSvgWrapper svg').length).toBe(1);
    });

    it('keeps the sizes when a song has no playable notes, and fits them again for the next song', async () => {
        const { container, findByText, getByText, getByRole } = render(<MusicBoxSheetGenerator />);
        fireEvent.click(getByText('Layout/Pagination'));
        const lengthInput = () => numericInput(within(getByRole('tabpanel')).getByText(/Max strip length/));
        const download = () => getByText('Download DXF(s)').closest('button') as HTMLButtonElement;

        // Only drums (MIDI channel 10): nothing to punch.
        const drums = buildMidi({ ppqn: 480, tracks: [[noteOn(0, 36, 100, 9), noteOff(480, 36, 9), endOfTrack()]] });
        pickFile(container, new File([drums], 'drums.mid', { type: 'audio/midi' }));
        await findByText('MIDI ready');
        expect(getByText('No supported MIDI notes!')).toBeTruthy();
        expect(download().disabled).toBe(true);
        expect(lengthInput().value).toBe('250');
        expect(container.querySelector('.mb-musicBoxSvgWrapper')).toBeNull();

        pickFile(container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        // The file name shows in the picker before the file is read: wait for the preview.
        await wait(() => expect(container.querySelector('.mb-musicBoxSvgWrapper')).not.toBeNull());
        expect(lengthInput().value).toBe(String(fittedFormat().pageWidthMm));
        expect(download().disabled).toBe(false);
        expect(container.querySelectorAll('.mb-musicBoxSvgWrapper svg').length).toBe(1);
    });

    it('fits the sheet again when the paper changes, even over sizes typed by hand', async () => {
        const { container, findByText, getByText, getByRole } = render(<MusicBoxSheetGenerator />);
        const panel = () => within(getByRole('tabpanel'));
        const layoutFields = () => {
            fireEvent.click(getByText('Layout/Pagination'));
            return [numericInput(panel().getByText(/Max strip length/)).value, numericInput(panel().getByText(/Sheet width/)).value];
        };
        pickFile(container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        await findByText('MIDI ready');

        // My own sizes...
        fireEvent.click(getByText('Layout/Pagination'));
        fireEvent.change(numericInput(panel().getByText(/Max strip length/)), { target: { value: '190' } });
        fireEvent.change(numericInput(panel().getByText(/Sheet width/)), { target: { value: '200' } });
        fireEvent.click(panel().getAllByText('Apply')[0]);
        expect(layoutFields()).toEqual(['190', '200']);

        // ... are replaced by the fitted ones when another profile is selected.
        fireEvent.click(getByText('Paper/Music Box Settings'));
        fireEvent.click(getByText('Select profile...'));
        fireEvent.click(await findByText('15 Note'));
        const fifteen = BuiltInProfiles['fifteenNote'];
        const fitted15 = fitSingleStrip(loadSampleMidi(), fifteen, DEFAULT_FORMAT);
        expect(layoutFields()).toEqual([String(fitted15.pageWidthMm), '41']);
        expect(container.querySelectorAll('.mb-musicBoxSvgWrapper svg').length).toBe(1);

        // Faster paper: longer strip, fitted again.
        fireEvent.click(getByText('Paper/Music Box Settings'));
        fireEvent.change(numericInput(panel().getByText(/Millimeters per second/)), { target: { value: '25' } });
        fireEvent.click(panel().getByText('Apply', { selector: '.mb-settingGroup button span, .mb-settingGroup button' }));
        const faster = { ...fifteen, millimetersPerSecond: 25 };
        const fittedFaster = fitSingleStrip(loadSampleMidi(), faster, DEFAULT_FORMAT);
        expect(fittedFaster.pageWidthMm).toBeGreaterThan(fitted15.pageWidthMm);
        expect(layoutFields()).toEqual([String(fittedFaster.pageWidthMm), '41']);

        // The download is exactly one strip, as computed.
        createdBlobs.length = 0;
        fireEvent.click(getByText('Download DXF(s)'));
        const downloaded = await Promise.all(createdBlobs.map(readBlob));
        expect(downloaded).toEqual(computeMusicBoxLayout(loadSampleMidi(), faster, fittedFaster).drawings.map(createDxf));
        expect(downloaded.length).toBe(1);
    });

    it('fits the sheet again when another track is selected', async () => {
        const { container, findByText, getByText, getByRole } = render(<MusicBoxSheetGenerator />);
        pickFile(container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        await findByText('MIDI ready');
        fireEvent.click(getByText('Layout/Pagination'));
        fireEvent.change(numericInput(within(getByRole('tabpanel')).getByText(/Max strip length/)), { target: { value: '100' } });
        fireEvent.click(within(getByRole('tabpanel')).getAllByText('Apply')[0]);

        fireEvent.click(getByText('MIDI / MP3 File'));
        fireEvent.change(container.querySelector('select') as HTMLSelectElement, { target: { value: 'all' } });
        const fitted = fitSingleStrip(loadSampleMidi(), BuiltInProfiles['thirtyNote'], DEFAULT_FORMAT, 'all');
        fireEvent.click(getByText('Layout/Pagination'));
        expect(numericInput(within(getByRole('tabpanel')).getByText(/Max strip length/)).value).toBe(String(fitted.pageWidthMm));
        expect(container.querySelectorAll('.mb-musicBoxSvgWrapper svg').length).toBe(1);
    });

    it('fits the sheet again for layout options that change the length, keeping the border and typed sizes', async () => {
        const { container, findByText, getByText, getByRole, getByLabelText } = render(<MusicBoxSheetGenerator />);
        pickFile(container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        await findByText('MIDI ready');
        fireEvent.click(getByText('Layout/Pagination'));
        const panel = () => within(getByRole('tabpanel'));
        const length = () => numericInput(panel().getByText(/Max strip length/));
        const across = () => numericInput(panel().getByText(/Sheet width/));
        const padding = () => numericInput(panel().getByText(/Start padding/));
        const apply = () => fireEvent.click(panel().getAllByText('Apply')[0]);
        const fitted = fittedFormat();

        // No border: nothing to fit again, and later fits keep it off.
        fireEvent.click(getByLabelText('Render border'));
        apply();
        expect(length().value).toBe(String(fitted.pageWidthMm));

        // A longer start padding makes the strip longer: fitted again, border still off.
        fireEvent.change(padding(), { target: { value: '30' } });
        apply();
        const padded = fittedFormat({ ...DEFAULT_FORMAT, startPaddingMm: 30, renderBorder: false });
        expect(padded.pageWidthMm).toBeGreaterThan(fitted.pageWidthMm);
        expect(length().value).toBe(String(padded.pageWidthMm));
        expect((getByLabelText('Render border') as HTMLInputElement).checked).toBe(false);
        expect(container.querySelectorAll('.mb-musicBoxSvgWrapper line[stroke="black"]').length).toBe(0);

        // Sizes typed together with a padding change are kept.
        fireEvent.change(padding(), { target: { value: '20' } });
        fireEvent.change(length(), { target: { value: '300' } });
        apply();
        expect([length().value, padding().value]).toEqual(['300', '20']);
        expect(container.querySelectorAll('.mb-musicBoxSvgWrapper svg').length).toBe(2);

        // Options that don't change the size don't touch my sizes.
        fireEvent.click(getByLabelText(/Mirror strips/));
        apply();
        expect([length().value, across().value]).toEqual(['300', '70.1']);
    });

    it('shows a readable error for a file that is not MIDI', async () => {
        const { container, findByText, getByText } = render(<MusicBoxSheetGenerator />);
        pickFile(container, new File(['hello'], 'notes.mid', { type: 'audio/midi' }));
        await findByText('This file could not be loaded');
        expect(getByText(/Not a valid MIDI file/)).toBeTruthy();
        expect(getByText('No MIDI loaded')).toBeTruthy();
    });

    it('keeps unapplied settings when switching tabs', () => {
        const { getByText, getByLabelText } = render(<MusicBoxSheetGenerator />);
        const tab = (name: string) => fireEvent.click(getByText(name));

        tab('Layout/Pagination');
        const mirror = getByLabelText(/Mirror strips/) as HTMLInputElement;
        expect(mirror.checked).toBe(false);
        fireEvent.click(mirror);
        expect(mirror.checked).toBe(true);

        tab('MIDI / MP3 File');
        tab('Paper/Music Box Settings');
        tab('Layout/Pagination');
        expect((getByLabelText(/Mirror strips/) as HTMLInputElement).checked).toBe(true);
    });

    it('warns about unapplied changes, and only uses applied values for the DXF', async () => {
        const { container, findByText, getByText, getByRole, queryByText } = render(<MusicBoxSheetGenerator />);
        pickFile(container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        await findByText('MIDI ready');

        fireEvent.click(getByText('Layout/Pagination'));
        const panel = () => within(getByRole('tabpanel'));
        const widthInput = () => numericInput(panel().getByText(/Max strip length/));
        // Vertical strips: the strip length is the sheet height (value after "$EXTMAX", "10", x, "20").
        const extMaxHeight = (dxf: string) => dxf.split('\r\n')[23];
        const fittedLength = String(fittedFormat().pageWidthMm);
        const downloadFirst = async () => {
            createdBlobs.length = 0;
            fireEvent.click(getByText('Download DXF(s)'));
            return readBlob(createdBlobs[0]);
        };

        fireEvent.change(widthInput(), { target: { value: '190' } });
        expect(panel().getByText('Changes not applied yet')).toBeTruthy();
        expect(getByText(/Settings not applied yet: Layout\/Pagination/)).toBeTruthy();
        // Not applied: the DXF still uses the applied length (fitted to the song when it was loaded).
        expect(extMaxHeight(await downloadFirst())).toBe(fittedLength);

        fireEvent.click(panel().getByText('Discard'));
        expect(widthInput().value).toBe(fittedLength);
        expect(queryByText('Changes not applied yet')).toBeNull();
        expect(queryByText(/Settings not applied yet/)).toBeNull();

        fireEvent.change(widthInput(), { target: { value: '190' } });
        fireEvent.click(panel().getAllByText('Apply')[0]);
        expect(queryByText(/Settings not applied yet/)).toBeNull();
        expect(extMaxHeight(await downloadFirst())).toBe('190');
    });

    it('disables the download while the settings make the strips impossible', async () => {
        const { container, findByText, getByText, getByRole } = render(<MusicBoxSheetGenerator />);
        pickFile(container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        await findByText('MIDI ready');
        const download = () => getByText('Download DXF(s)').closest('button') as HTMLButtonElement;
        expect(download().disabled).toBe(false);

        fireEvent.click(getByText('Layout/Pagination'));
        const panel = within(getByRole('tabpanel'));
        // Vertical strips are side by side: the sheet width must fit one 70.1 mm strip.
        fireEvent.change(numericInput(panel.getByText(/Sheet width/)), { target: { value: '50' } });
        fireEvent.click(panel.getAllByText('Apply')[0]);
        expect(download().disabled).toBe(true);
        expect(download().title).toMatch(/Sheet width must be at least 70.10 mm/);

        fireEvent.change(numericInput(within(getByRole('tabpanel')).getByText(/Sheet width/)), { target: { value: '200' } });
        fireEvent.click(within(getByRole('tabpanel')).getAllByText('Apply')[0]);
        expect(download().disabled).toBe(false);
    });
});

describe('MusicBoxSheetGenerator with MP3 files (experimental)', () => {
    const createdBlobs: Blob[] = [];
    const downloadedNames: string[] = [];
    // C4 for 40 frames, E4 for 20 frames and a short G4 (8 frames): the default minimum note
    // length (11 frames) drops the G4.
    const ANALYSIS = activations([[60, 43, 40], [64, 86, 20], [67, 129, 8]]);

    beforeEach(() => {
        createdBlobs.length = 0;
        downloadedNames.length = 0;
        audioMocks.decodeError = false;
        audioMocks.analysis = ANALYSIS;
        audioMocks.gate = null;
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn((blob: Blob) => {
                createdBlobs.push(blob);
                return 'blob:test-' + createdBlobs.length;
            }),
        });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
            downloadedNames.push(this.download);
        });
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    const mp3 = (name = 'melody.mp3') => new File([new Uint8Array([0xFF, 0xFB, 0x90, 0x00])], name, { type: 'audio/mpeg' });
    const circles = (container: HTMLElement) => container.querySelectorAll('.mb-musicBoxSvgWrapper circle[stroke="black"]').length;
    const sliderHandle = (container: HTMLElement, setting: string) =>
        // Blueprint's class prefix differs in the tests ("undefined-" instead of "bp3-").
        container.querySelector(`.mb-audioSlider[data-setting="${setting}"] [class$="-slider-handle"]`) as HTMLElement;
    /** Moves a slider with the keyboard and releases it. */
    function moveSlider(container: HTMLElement, setting: string, steps: number) {
        const handle = sliderHandle(container, setting);
        const key = steps < 0 ? { which: 37, keyCode: 37 } : { which: 39, keyCode: 39 };
        for (let i = 0; i < Math.abs(steps); i++) {
            fireEvent.keyDown(handle, key);
        }
        fireEvent.keyUp(handle, key);
    }

    it('says before loading that MP3 is experimental and that MIDI files are preferable', () => {
        const { container, getByText } = render(<MusicBoxSheetGenerator />);
        expect(getByText('MIDI / MP3 File')).toBeTruthy();
        expect(getByText(/MIDI files give exact results and are preferable. MP3 files are experimental/)).toBeTruthy();
        expect(getByText(/melody played on piano or a\s+similar single instrument/)).toBeTruthy();
        expect(getByText(/MIDI or MP3 \(experimental\)/)).toBeTruthy();
        expect((container.querySelector('input[type="file"]') as HTMLInputElement).getAttribute('accept')).toContain('.mp3');
    });

    it('converts an MP3 to notes that follow the MIDI flow: preview, piano notes and DXF', async () => {
        const { container, findByText, getByText, getAllByText } = render(<MusicBoxSheetGenerator />);
        pickFile(container, mp3());
        await findByText('MIDI ready');

        // The notes Basic Pitch finds with the default settings, laid out like a MIDI file.
        const expected = expectedAudioMidi(ANALYSIS, DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS);
        const format = fitSingleStrip(expected, BuiltInProfiles['thirtyNote'], DEFAULT_FORMAT);
        const layout = computeMusicBoxLayout(expected, BuiltInProfiles['thirtyNote'], format);
        expect(layout.extraction.notes.map(n => n.note)).toEqual([60, 64]);
        expect(circles(container)).toBe(2);
        // The C4 starts at frame 43 (0.5 s): that silence is removed, the E4 stays 0.5 s later.
        expect(layout.extraction.notes[0].timeSeconds).toBe(0);
        expect(layout.extraction.notes[1].timeSeconds).toBeCloseTo(0.4993, 3);
        expect(getByText(/The 0\.50 s of silence before the first note were removed/)).toBeTruthy();

        expect(getByText('2 notes detected.')).toBeTruthy();
        expect(getAllByText('MP3 support is experimental').length).toBe(1);
        expect(getByText(/A MIDI file is always preferable/)).toBeTruthy();
        expect(getByText('128 ms (default)')).toBeTruthy();
        expect((getByText('Reset to defaults').closest('button') as HTMLButtonElement).disabled).toBe(true);

        fireEvent.click(getByText('Download DXF(s)'));
        expect(await Promise.all(createdBlobs.map(readBlob))).toEqual(layout.drawings.map(createDxf));
        expect(downloadedNames).toEqual(['melody_page_1.dxf']);
    });

    it('detects the notes again when a slider is released, and fits the sheet to the new notes', async () => {
        const { container, findByText, getByText, getByRole } = render(<MusicBoxSheetGenerator />);
        pickFile(container, mp3());
        await findByText('2 notes detected.');

        // A shorter minimum note length (11 -> 7 frames) keeps the short G4.
        moveSlider(container, 'minNoteLengthFrames', -4);
        await findByText('3 notes detected.');
        expect(container.querySelector('[data-setting="minNoteLengthFrames"] .mb-audioSlider-value')!.textContent).toBe('81 ms');
        const settings = { ...DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS, minNoteLengthFrames: 7 };
        const expected = expectedAudioMidi(ANALYSIS, settings);
        const format = fitSingleStrip(expected, BuiltInProfiles['thirtyNote'], DEFAULT_FORMAT);
        expect(circles(container)).toBe(3);

        fireEvent.click(getByText('Layout/Pagination'));
        expect(numericInput(within(getByRole('tabpanel')).getByText(/Max strip length/)).value).toBe(String(format.pageWidthMm));

        fireEvent.click(getByText('Download DXF(s)'));
        expect(await Promise.all(createdBlobs.map(readBlob)))
            .toEqual(computeMusicBoxLayout(expected, BuiltInProfiles['thirtyNote'], format).drawings.map(createDxf));

        // Back to the defaults.
        fireEvent.click(getByText('MIDI / MP3 File'));
        fireEvent.click(getByText('Reset to defaults'));
        await findByText('2 notes detected.');
        expect(circles(container)).toBe(2);
    });

    it('holes deleted by hand are dropped when the notes are detected again (and the panel says so)', async () => {
        const { container, findByText, getByText, getByLabelText, queryByText } = render(<MusicBoxSheetGenerator />);
        pickFile(container, mp3());
        await findByText('2 notes detected.');
        const holes = () => container.querySelectorAll('.mb-musicBoxSvgWrapper circle[stroke="black"]');
        const svg = container.querySelector('.mb-musicBoxSvgWrapper svg') as SVGSVGElement;
        svg.getBoundingClientRect = () => {
            const [, , w, h] = svg.getAttribute('viewBox')!.split(' ').map(Number);
            return { left: 0, top: 0, x: 0, y: 0, width: w, height: h, right: w, bottom: h, toJSON: () => ({}) };
        };
        const first = holes()[0];
        fireEvent.click(svg, { clientX: Number(first.getAttribute('cx')), clientY: Number(first.getAttribute('cy')) });
        expect(holes().length).toBe(1);
        expect(getByText(/You deleted 1 hole by hand\.\s+Moving a slider detects the notes again and undoes those changes/)).toBeTruthy();
        // A hole added by hand too: in the middle of the strip (vertical), on a line far from the two notes.
        const [, , w, h] = svg.getAttribute('viewBox')!.split(' ').map(Number);
        fireEvent.click(svg, { clientX: w / 2, clientY: h - 4 });
        expect(holes().length).toBe(2);
        expect(getByText(/You deleted 1 hole and added 1 hole by hand\./)).toBeTruthy();

        // The MIDI of an MP3 is written at a fixed 120 bpm: its beats mean nothing, so they start hidden.
        expect(container.querySelectorAll('.mb-beatLine-quarter').length).toBe(0);
        expect((getByLabelText('Beat lines') as HTMLInputElement).checked).toBe(false);

        moveSlider(container, 'minNoteLengthFrames', -4);
        await findByText('3 notes detected.');
        expect(holes().length).toBe(3);
        expect(getByText('No holes added or deleted')).toBeTruthy();
        expect((getByText('Undo').closest('button') as HTMLButtonElement).disabled).toBe(true);
        expect(queryByText(/You deleted/)).toBeNull();
    });

    it('can end up with no notes: the preview explains it and the download is disabled', async () => {
        audioMocks.analysis = activations([]);
        const { container, findByText, getByText } = render(<MusicBoxSheetGenerator />);
        pickFile(container, mp3());
        await findByText('0 notes detected.');
        expect(getByText('No supported MIDI notes!')).toBeTruthy();
        expect((getByText('Download DXF(s)').closest('button') as HTMLButtonElement).disabled).toBe(true);
        expect(circles(container)).toBe(0);
    });

    it('shows the progress, and ignores the MP3 if another file is picked meanwhile', async () => {
        let open: () => void = () => undefined;
        audioMocks.gate = new Promise<void>(resolve => { open = resolve; });
        const { container, findByText, getByText, queryByText } = render(<MusicBoxSheetGenerator />);
        pickFile(container, mp3('slow.mp3'));
        await findByText(/Detecting the notes of the audio… 0%/);
        expect(getByText('MP3 support is experimental')).toBeTruthy();
        expect(getByText('No MIDI loaded')).toBeTruthy();

        pickFile(container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        await findByText('MIDI ready');
        open();
        await new Promise(resolve => setTimeout(resolve, 20));
        // Still the MIDI file: no sliders, its own notes.
        expect(queryByText(/notes detected/)).toBeNull();
        expect(queryByText('MP3 support is experimental')).toBeNull();
        expect(container.querySelector('h2')!.textContent).toBe(SAMPLE);
        expect(circles(container)).toBe(computeMusicBoxLayout(loadSampleMidi(), BuiltInProfiles['thirtyNote'], fittedFormat()).extraction.notes.length);
    });

    it('shows a readable error for an MP3 that cannot be decoded', async () => {
        audioMocks.decodeError = true;
        const { container, findByText, getByText } = render(<MusicBoxSheetGenerator />);
        pickFile(container, mp3('broken.mp3'));
        await findByText('This file could not be loaded');
        expect(getByText('The audio could not be decoded. Make sure the file is a valid MP3.')).toBeTruthy();
        expect(getByText('No MIDI loaded')).toBeTruthy();
    });

    it('loads a MIDI file normally after an MP3, without the MP3 settings', async () => {
        const { container, findByText, queryByText } = render(<MusicBoxSheetGenerator />);
        pickFile(container, mp3());
        await findByText('2 notes detected.');
        pickFile(container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        await wait(() => expect(queryByText(/notes detected/)).toBeNull());
        await findByText('MIDI ready');
        expect(queryByText(/Tempo:/)).not.toBeNull();
        expect(circles(container)).toBe(computeMusicBoxLayout(loadSampleMidi(), BuiltInProfiles['thirtyNote'], fittedFormat()).extraction.notes.length);
    });
});

describe('MusicBoxSheetGenerator: deleting holes in the preview', () => {
    const createdBlobs: Blob[] = [];
    const THIRTY = BuiltInProfiles['thirtyNote'];
    /** jsdom has no layout: every sheet is drawn at 10 px per mm, at the top-left corner. */
    const PX_PER_MM = 10;

    beforeEach(() => {
        createdBlobs.length = 0;
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn((blob: Blob) => {
                createdBlobs.push(blob);
                return 'blob:test-' + createdBlobs.length;
            }),
        });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    /** The holes drawn from the DXF (not the highlights). */
    const dxfHoles = (container: HTMLElement) => container.querySelectorAll('.mb-musicBoxSvgWrapper circle[stroke="black"]').length;
    const selectedHoles = (container: HTMLElement) => container.querySelectorAll('.mb-hole-selected').length;
    const button = (getByText: (text: string | RegExp) => HTMLElement, text: string | RegExp) =>
        getByText(text).closest('button') as HTMLButtonElement;
    const layoutFor = (deleted: string[] = [], format = fittedFormat(), profile = THIRTY) =>
        computeMusicBoxLayout(loadSampleMidi(), profile, format, 'auto', new Set(deleted));

    /** Clicks (or taps) the hole of `noteId`, at its position in the layout the app should show. */
    function clickHole(container: HTMLElement, layout: IMusicBoxLayout, noteId: string) {
        const sheet = layout.holeNotes.findIndex(notes => notes.some(n => n.id === noteId));
        expect(sheet).toBeGreaterThanOrEqual(0);
        const index = layout.holeNotes[sheet].findIndex(n => n.id === noteId);
        const circle = parseDxf(createDxf(layout.drawings[sheet])).circles[index];
        const svg = container.querySelectorAll('.mb-musicBoxSvgWrapper svg')[sheet] as SVGSVGElement;
        svg.getBoundingClientRect = () => {
            const [, , w, h] = svg.getAttribute('viewBox')!.split(' ').map(Number);
            return { left: 0, top: 0, x: 0, y: 0, width: w * PX_PER_MM, height: h * PX_PER_MM, right: w * PX_PER_MM, bottom: h * PX_PER_MM, toJSON: () => ({}) };
        };
        fireEvent.click(svg, { clientX: circle.cx * PX_PER_MM, clientY: circle.cy * PX_PER_MM });
    }

    async function loadSample() {
        const utils = render(<MusicBoxSheetGenerator />);
        pickFile(utils.container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        await utils.findByText('MIDI ready');
        return utils;
    }

    async function downloadAll(getByText: (text: string) => HTMLElement): Promise<string[]> {
        createdBlobs.length = 0;
        fireEvent.click(getByText('Download DXF(s)'));
        return Promise.all(createdBlobs.map(readBlob));
    }

    const key = (k: string, extra: object = {}) => fireEvent.keyDown(document.body, { key: k, ...extra });

    /**
     * The layout the app shows with these holes removed: a sheet fitted to the song is fitted again
     * after every click (sizes typed by hand are kept).
     */
    const appLayout = (deleted: string[] = [], typed?: IMusicBoxSvgFormatOptions, profile = THIRTY) =>
        computeMusicBoxLayout(loadSampleMidi(), profile,
            typed ?? fitSingleStrip(loadSampleMidi(), profile, DEFAULT_FORMAT, 'auto', new Set(deleted)), 'auto', new Set(deleted));
    /** Clicks the holes one after the other: each click removes one (the others may move with it). */
    function removeHoles(container: HTMLElement, ids: string[], already: string[] = [], typed?: IMusicBoxSvgFormatOptions) {
        const removed = [...already];
        ids.forEach(id => {
            clickHole(container, appLayout(removed, typed), id);
            removed.push(id);
        });
    }

    it('a click on a hole removes it at once, and the DXF is downloaded without it; there is no selection nor Delete button', async () => {
        const { container, getByText, queryByText } = await loadSample();
        const ids = layoutFor().extraction.notes.map(n => n.id);
        const total = ids.length;
        expect(dxfHoles(container)).toBe(total);
        expect(getByText(/Click a hole to remove it/)).toBeTruthy();
        expect(queryByText('Delete')).toBeNull();
        expect(queryByText('Unselect')).toBeNull();
        expect(getByText('No holes added or deleted')).toBeTruthy();

        removeHoles(container, [ids[5]]);
        expect(dxfHoles(container)).toBe(total - 1);
        expect(selectedHoles(container)).toBe(0);
        expect(getByText('1 hole deleted')).toBeTruthy();
        expect(await downloadAll(getByText)).toEqual(appLayout([ids[5]]).drawings.map(createDxf));

        removeHoles(container, [ids[10]], [ids[5]]);
        expect(dxfHoles(container)).toBe(total - 2);
        expect(getByText('2 holes deleted')).toBeTruthy();
        expect(await downloadAll(getByText)).toEqual(appLayout([ids[5], ids[10]]).drawings.map(createDxf));

        // The Delete, Backspace and Esc keys do nothing (and keep their default behavior).
        expect(key('Delete')).toBe(true);
        expect(key('Backspace')).toBe(true);
        expect(key('Escape')).toBe(true);
        expect(dxfHoles(container)).toBe(total - 2);
    });

    it('undoes one click at a time with the button or Ctrl+Z / Cmd+Z, and restores everything (undoable)', async () => {
        const { container, getByText } = await loadSample();
        const ids = layoutFor().extraction.notes.map(n => n.id);
        const total = ids.length;
        expect(button(getByText, 'Undo').disabled).toBe(true);
        expect(button(getByText, 'Restore all').disabled).toBe(true);

        removeHoles(container, [ids[3], ids[7], ids[8]]);
        expect(dxfHoles(container)).toBe(total - 3);
        expect(button(getByText, 'Undo').disabled).toBe(false);

        expect(key('z', { ctrlKey: true })).toBe(false);
        expect(dxfHoles(container)).toBe(total - 2);
        fireEvent.click(getByText('Undo'));
        expect(dxfHoles(container)).toBe(total - 1);
        fireEvent.click(getByText('Undo'));
        expect(dxfHoles(container)).toBe(total);
        expect(button(getByText, 'Undo').disabled).toBe(true);
        // Nothing left to undo: Ctrl+Z is left alone.
        expect(key('z', { ctrlKey: true })).toBe(true);

        removeHoles(container, [ids[1], ids[2]]);
        expect(dxfHoles(container)).toBe(total - 2);
        fireEvent.click(getByText('Restore all'));
        expect(dxfHoles(container)).toBe(total);
        expect(button(getByText, 'Restore all').disabled).toBe(true);
        expect(await downloadAll(getByText)).toEqual(layoutFor().drawings.map(createDxf));

        // "Restore all" can be undone (Cmd+Z on a Mac).
        key('z', { metaKey: true });
        expect(dxfHoles(container)).toBe(total - 2);
        expect(await downloadAll(getByText)).toEqual(appLayout([ids[1], ids[2]]).drawings.map(createDxf));
        // Ctrl+Shift+Z (redo in some apps) does nothing here.
        key('z', { ctrlKey: true, shiftKey: true });
        expect(dxfHoles(container)).toBe(total - 2);
    });

    it('leaves Ctrl+Z alone while typing in a field (it undoes the text there)', async () => {
        const { container, getByText, getByRole } = await loadSample();
        const ids = layoutFor().extraction.notes.map(n => n.id);
        const total = ids.length;
        removeHoles(container, [ids[3]]);

        fireEvent.click(getByText('Layout/Pagination'));
        const input = numericInput(within(getByRole('tabpanel')).getByText(/Start padding/));
        expect(fireEvent.keyDown(input, { key: 'z', ctrlKey: true })).toBe(true);
        expect(fireEvent.keyDown(input, { key: 'Backspace' })).toBe(true);
        expect(dxfHoles(container)).toBe(total - 1);
    });

    it('a sheet fitted to the song is fitted again when its last notes are removed; sizes typed by hand are kept', async () => {
        const { container, getByText, getByRole } = await loadSample();
        const panel = () => within(getByRole('tabpanel'));
        const sizes = () => {
            fireEvent.click(getByText('Layout/Pagination'));
            return [numericInput(panel().getByText(/Max strip length/)).value, numericInput(panel().getByText(/Sheet width/)).value];
        };
        const notes = layoutFor().extraction.notes;
        const lastTime = notes[notes.length - 1].timeSeconds;
        const last = notes.filter(n => n.timeSeconds === lastTime).map(n => n.id);
        const fitted = fittedFormat();
        const shorter = fitSingleStrip(loadSampleMidi(), THIRTY, DEFAULT_FORMAT, 'auto', new Set(last));
        expect(shorter.pageWidthMm).toBeLessThan(fitted.pageWidthMm);

        removeHoles(container, last);
        expect(sizes()).toEqual([String(shorter.pageWidthMm), '70.1']);
        expect(await downloadAll(getByText)).toEqual(layoutFor(last, shorter).drawings.map(createDxf));

        // Undo (one click at a time): the whole song again, on its fitted sheet.
        last.forEach(() => fireEvent.click(getByText('Undo')));
        expect(sizes()).toEqual([String(fitted.pageWidthMm), '70.1']);

        // Interior holes don't change the length.
        removeHoles(container, [notes[4].id]);
        expect(sizes()).toEqual([String(fitted.pageWidthMm), '70.1']);
        fireEvent.click(getByText('Undo'));

        // My own sizes are kept.
        fireEvent.change(numericInput(panel().getByText(/Max strip length/)), { target: { value: '190' } });
        fireEvent.change(numericInput(panel().getByText(/Sheet width/)), { target: { value: '200' } });
        fireEvent.click(panel().getAllByText('Apply')[0]);
        const typed = { ...fitted, pageWidthMm: 190, pageHeightMm: 200 };
        removeHoles(container, last, [], typed);
        expect(sizes()).toEqual(['190', '200']);
        expect(await downloadAll(getByText)).toEqual(layoutFor(last, typed).drawings.map(createDxf));
    });

    it('removing the first holes moves the rest back: no blank paper at the start, the fitted sheet gets shorter, the piano stays in place', async () => {
        vi.spyOn(PianoPlayer, 'isSupported').mockReturnValue(true);
        const updates: Array<[unknown, number | undefined]> = [];
        vi.spyOn(PianoPlayer.prototype, 'updateSequence').mockImplementation((sequence, shift) => { updates.push([sequence, shift]); });
        vi.spyOn(PianoPlayer.prototype, 'getState').mockReturnValue('playing');

        const { container, getByText, getByRole } = await loadSample();
        const sizes = () => {
            fireEvent.click(getByText('Layout/Pagination'));
            const panel = within(getByRole('tabpanel'));
            return [numericInput(panel.getByText(/Max strip length/)).value, numericInput(panel.getByText(/Sheet width/)).value];
        };
        const notes = layoutFor().extraction.notes;
        const times = [...new Set(notes.map(n => n.timeSeconds))];
        const first = notes.filter(n => n.timeSeconds === times[0]).map(n => n.id);
        const removed = times[1] - times[0];
        const midi = loadSampleMidi();
        const shorter = fitSingleStrip(midi, THIRTY, DEFAULT_FORMAT, 'auto', new Set(first));
        expect(shorter.pageWidthMm).toBeLessThan(fittedFormat().pageWidthMm);

        removeHoles(container, first);
        expect(sizes()).toEqual([String(shorter.pageWidthMm), '70.1']);
        const after = layoutFor(first, shorter);
        expect(after.extraction.removedLeadingSeconds).toBeCloseTo(removed, 9);
        expect(await downloadAll(getByText)).toEqual(after.drawings.map(createDxf));
        // The piano gets the notes after every click, and is told how far the song moved (in all,
        // the room of the removed holes): it stays at the same point of the music.
        const pianoWithout = (deleted: string[]) => buildGeneratedMusicBoxSequence(midi, THIRTY,
            { transposeOutOfRangeNotes: true, includePercussion: false, trackSelection: 'auto', deletedNoteIds: new Set(deleted), addedNotes: [] });
        expect(updates.length).toBe(first.length);
        expect(updates[updates.length - 1][0]).toEqual(pianoWithout(first));
        expect(updates.reduce((sum, [, shift]) => sum + (shift ?? 0), 0)).toBeCloseTo(removed, 9);

        // Undo brings back the last one: the song starts where it did, and the piano moves forward again.
        key('z', { ctrlKey: true });
        expect(sizes()).toEqual([String(fittedFormat().pageWidthMm), '70.1']);
        expect(await downloadAll(getByText)).toEqual(appLayout(first.slice(0, -1)).drawings.map(createDxf));
        expect(updates[updates.length - 1][0]).toEqual(pianoWithout(first.slice(0, -1)));
        expect(updates[updates.length - 1][1]).toBeCloseTo(-removed, 9);
    });

    it('the piano never plays removed holes; while playing or paused it goes on with the new notes', async () => {
        vi.spyOn(PianoPlayer, 'isSupported').mockReturnValue(true);
        const played: unknown[] = [];
        vi.spyOn(PianoPlayer.prototype, 'play').mockImplementation(async (sequence) => { played.push(sequence); });
        const updated: unknown[] = [];
        const shifts: unknown[] = [];
        vi.spyOn(PianoPlayer.prototype, 'updateSequence').mockImplementation((sequence, shift) => { updated.push(sequence); shifts.push(shift); });
        const state = vi.spyOn(PianoPlayer.prototype, 'getState').mockReturnValue('stopped');

        const { container, getByText } = await loadSample();
        const ids = layoutFor().extraction.notes.map(n => n.id);
        const pianoWithout = (deleted: string[]) => buildGeneratedMusicBoxSequence(loadSampleMidi(), THIRTY,
            { transposeOutOfRangeNotes: true, includePercussion: false, trackSelection: 'auto', deletedNoteIds: new Set(deleted), addedNotes: [] });

        // Stopped: nothing to update; the next play has no removed notes.
        removeHoles(container, [ids[2]]);
        expect(updated.length).toBe(0);
        fireEvent.click(getByText('Restart piano'));
        await wait(() => expect(played.length).toBe(1));
        expect(played[0]).toEqual(pianoWithout([ids[2]]));
        expect((played[0] as unknown[]).length).toBe(ids.length - 1);

        // Playing: the song is updated where it is (not restarted).
        state.mockReturnValue('playing');
        removeHoles(container, [ids[6]], [ids[2]]);
        expect(updated).toEqual([pianoWithout([ids[2], ids[6]])]);
        expect(shifts).toEqual([0]);
        // Paused too, and undo brings the note back to the piano.
        state.mockReturnValue('paused');
        key('z', { ctrlKey: true });
        expect(updated[1]).toEqual(pianoWithout([ids[2]]));
        expect(played.length).toBe(1);
    });

    it('keeps the removed holes when the settings change, and forgets them when a file is loaded', async () => {
        const { container, getByText, findByText } = await loadSample();
        const fifteen = BuiltInProfiles['fifteenNote'];
        // A note that the 15 note box can play too.
        const notes15 = computeMusicBoxLayout(loadSampleMidi(), fifteen, fitSingleStrip(loadSampleMidi(), fifteen, DEFAULT_FORMAT)).extraction.notes;
        const target = layoutFor().extraction.notes.find(n => notes15.some(m => m.id === n.id))!;
        removeHoles(container, [target.id]);

        fireEvent.click(getByText('Paper/Music Box Settings'));
        fireEvent.click(getByText('Select profile...'));
        fireEvent.click(await findByText('15 Note'));
        const format15 = fitSingleStrip(loadSampleMidi(), fifteen, DEFAULT_FORMAT, 'auto', new Set([target.id]));
        const expected15 = computeMusicBoxLayout(loadSampleMidi(), fifteen, format15, 'auto', new Set([target.id]));
        expect(expected15.extraction.deletedCount).toBe(1);
        expect(dxfHoles(container)).toBe(notes15.length - 1);
        expect(await downloadAll(getByText)).toEqual(expected15.drawings.map(createDxf));
        expect(getByText('1 hole deleted')).toBeTruthy();

        // Loading a file (even the same one) starts with every hole.
        pickFile(container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        await wait(() => expect(getByText('No holes added or deleted')).toBeTruthy());
        expect(dxfHoles(container)).toBe(notes15.length);
        expect(button(getByText, 'Undo').disabled).toBe(true);
    });

    it('removing every hole explains how to bring them back; undo and restore all do', async () => {
        const { container, getByText } = await loadSample();
        const layout = layoutFor();
        const ids = layout.extraction.notes.map(n => n.id);
        removeHoles(container, ids);
        expect(getByText('Every hole was deleted. Use Undo or Restore all to bring them back.')).toBeTruthy();
        expect(button(getByText, 'Download DXF(s)').disabled).toBe(true);
        expect(dxfHoles(container)).toBe(0);

        fireEvent.click(getByText('Undo'));
        expect(dxfHoles(container)).toBe(1);
        fireEvent.click(getByText('Restore all'));
        expect(dxfHoles(container)).toBe(ids.length);
        expect(await downloadAll(getByText)).toEqual(layout.drawings.map(createDxf));
    });
});

describe('MusicBoxSheetGenerator: adding holes in the preview', () => {
    const createdBlobs: Blob[] = [];
    const THIRTY = BuiltInProfiles['thirtyNote'];
    const PX_PER_MM = 10;
    const positions = getNoteLinePositions(THIRTY);

    beforeEach(() => {
        createdBlobs.length = 0;
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn((blob: Blob) => {
                createdBlobs.push(blob);
                return 'blob:test-' + createdBlobs.length;
            }),
        });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    const dxfCircles = (container: HTMLElement) => Array.from(container.querySelectorAll('.mb-musicBoxSvgWrapper circle[stroke="black"]'))
        .map(c => ({ cx: Number(c.getAttribute('cx')), cy: Number(c.getAttribute('cy')) }));
    const dxfHoles = (container: HTMLElement) => dxfCircles(container).length;
    const button = (getByText: (text: string | RegExp) => HTMLElement, text: string | RegExp) =>
        getByText(text).closest('button') as HTMLButtonElement;
    const layoutFor = (added: IAddedNote[] = [], deleted: string[] = [], format?: IMusicBoxSvgFormatOptions, profile = THIRTY) =>
        computeMusicBoxLayout(loadSampleMidi(), profile, format ?? fitSingleStrip(loadSampleMidi(), profile, DEFAULT_FORMAT, 'auto', new Set(deleted), added),
            'auto', new Set(deleted), added);
    const added = (note: number, timeSeconds: number, n = 1): IAddedNote => ({ id: addedNoteId(n), note, timeSeconds });
    const key = (k: string, extra: object = {}) => fireEvent.keyDown(document.body, { key: k, ...extra });

    /** The point of the (single, vertical) strip where a hole of `note` at song time `seconds` goes. */
    function pointOf(layout: IMusicBoxLayout, note: number, seconds: number) {
        const sheet = layout.sheets[0];
        const along = (seconds - layout.pages[0].startTimeInSeconds) * THIRTY.millimetersPerSecond;
        const across = positions.get(note)!;
        const line = placeStripLine(sheet, sheet.strips[0], { x1: along, y1: across, x2: along, y2: across }, 'vertical');
        return { x: line.x1, y: line.y1 };
    }
    function clickAt(container: HTMLElement, x: number, y: number, extra: object = {}) {
        const svg = container.querySelector('.mb-musicBoxSvgWrapper svg') as SVGSVGElement;
        svg.getBoundingClientRect = () => {
            const [, , w, h] = svg.getAttribute('viewBox')!.split(' ').map(Number);
            return { left: 0, top: 0, x: 0, y: 0, width: w * PX_PER_MM, height: h * PX_PER_MM, right: w * PX_PER_MM, bottom: h * PX_PER_MM, toJSON: () => ({}) };
        };
        fireEvent.pointerDown(svg, { pointerType: 'mouse', clientX: x * PX_PER_MM, clientY: y * PX_PER_MM, ...extra });
        fireEvent.click(svg, { clientX: x * PX_PER_MM, clientY: y * PX_PER_MM, ...extra });
    }
    /** Clicks the empty spot where a hole of `note` at `seconds` goes. */
    const clickEmpty = (container: HTMLElement, layout: IMusicBoxLayout, note: number, seconds: number) => {
        const point = pointOf(layout, note, seconds);
        clickAt(container, point.x, point.y);
    };
    /** A note with no hole within a second of `seconds`. */
    const freeNote = (layout: IMusicBoxLayout, seconds: number) => [...THIRTY.supportedNotes].sort((a, b) => b - a).find(note =>
        !layout.extraction.notes.some(n => n.note === note && Math.abs(n.timeSeconds - seconds) < 1))!;
    /** A moment between two notes of the song, far from any hole in time. */
    function gapTime(layout: IMusicBoxLayout): number {
        const notes = layout.extraction.notes;
        for (let i = 0; i < notes.length - 1; i++) {
            if (notes[i + 1].timeSeconds - notes[i].timeSeconds > 0.4) {
                return (notes[i].timeSeconds + notes[i + 1].timeSeconds) / 2;
            }
        }
        throw new Error('no gap');
    }

    async function loadSample() {
        const utils = render(<MusicBoxSheetGenerator />);
        pickFile(utils.container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        await utils.findByText('MIDI ready');
        return utils;
    }

    async function downloadAll(getByText: (text: string) => HTMLElement): Promise<string[]> {
        createdBlobs.length = 0;
        fireEvent.click(getByText('Download DXF(s)'));
        return Promise.all(createdBlobs.map(readBlob));
    }

    it('a click on an empty spot adds a hole on that note line: the preview, the DXF, the status and the piano follow; undo removes it', async () => {
        vi.spyOn(PianoPlayer, 'isSupported').mockReturnValue(true);
        const previewed: unknown[] = [];
        vi.spyOn(PianoPlayer.prototype, 'previewNote').mockImplementation(async (note) => { previewed.push(note); });
        const played: unknown[] = [];
        vi.spyOn(PianoPlayer.prototype, 'play').mockImplementation(async (sequence) => { played.push(sequence); });

        const { container, getByText } = await loadSample();
        const layout = layoutFor();
        const total = layout.extraction.notes.length;
        expect(getByText(/Click an empty spot of a strip to add a hole/)).toBeTruthy();
        expect(getByText('No holes added or deleted')).toBeTruthy();
        expect(container.querySelectorAll('.mb-noteLine').length).toBe(THIRTY.supportedNotes.length);

        const seconds = gapTime(layout);
        const note = freeNote(layout, seconds);
        const before = dxfCircles(container);
        clickEmpty(container, layout, note, seconds);
        expect(dxfHoles(container)).toBe(total + 1);
        expect(getByText('1 hole added')).toBeTruthy();
        expect(getByText('1 hole added by hand.')).toBeTruthy();
        // The hole is exactly where the click was, and no other hole moved.
        const point = pointOf(layout, note, seconds);
        const after = dxfCircles(container);
        expect(after.filter(c => Math.abs(c.cx - point.x) < 1e-6 && Math.abs(c.cy - point.y) < 1e-6).length).toBe(1);
        before.forEach(c => expect(after.some(d => Math.abs(d.cx - c.cx) < 1e-9 && Math.abs(d.cy - c.cy) < 1e-9)).toBe(true));
        // The DXF is the one computed with that hole (interior: the fitted sheet keeps its size).
        const expected = layoutFor([added(note, seconds)]);
        expect(expected.extraction.addedCount).toBe(1);
        expect(expected.format.pageWidthMm).toBe(layout.format.pageWidthMm);
        expect(await downloadAll(getByText)).toEqual(expected.drawings.map(createDxf));
        // It sounded once, and the piano plays it.
        expect(previewed).toEqual([{ note, velocity: expected.extraction.notes.find(n => n.id === 'added:1')!.velocity }]);
        fireEvent.click(getByText('Restart piano'));
        await wait(() => expect(played.length).toBe(1));
        expect(played[0]).toEqual(buildGeneratedMusicBoxSequence(loadSampleMidi(), THIRTY,
            { transposeOutOfRangeNotes: true, includePercussion: false, trackSelection: 'auto', deletedNoteIds: new Set(), addedNotes: [added(note, seconds)] }));
        expect((played[0] as unknown[]).length).toBe(total + 1);

        // Undo.
        expect(key('z', { ctrlKey: true })).toBe(false);
        expect(dxfHoles(container)).toBe(total);
        expect(getByText('No holes added or deleted')).toBeTruthy();
        expect(await downloadAll(getByText)).toEqual(layout.drawings.map(createDxf));
        expect(button(getByText, 'Undo').disabled).toBe(true);
    });

    it('a click on an added hole removes it at once, like any other; it counts nowhere then', async () => {
        const { container, getByText } = await loadSample();
        const layout = layoutFor();
        const total = layout.extraction.notes.length;
        const seconds = gapTime(layout);
        const note = freeNote(layout, seconds);
        clickEmpty(container, layout, note, seconds);
        expect(dxfHoles(container)).toBe(total + 1);
        // Clicking the new hole removes it (it doesn't add another one).
        clickEmpty(container, layout, note, seconds);
        expect(container.querySelectorAll('.mb-hole-selected').length).toBe(0);
        expect(dxfHoles(container)).toBe(total);
        expect(getByText('No holes added or deleted')).toBeTruthy();
        expect(await downloadAll(getByText)).toEqual(layoutFor([added(note, seconds)], ['added:1']).drawings.map(createDxf));
        fireEvent.click(getByText('Undo'));
        expect(dxfHoles(container)).toBe(total + 1);
        expect(getByText('1 hole added')).toBeTruthy();
    });

    it('a hole added after the end of the song makes the fitted sheet longer; restore all goes back to the file', async () => {
        const { container, getByText, getByRole } = await loadSample();
        const sizes = () => {
            fireEvent.click(getByText('Layout/Pagination'));
            const panel = within(getByRole('tabpanel'));
            return [numericInput(panel.getByText(/Max strip length/)).value, numericInput(panel.getByText(/Sheet width/)).value];
        };
        const layout = layoutFor();
        const total = layout.extraction.notes.length;
        const fitted = fittedFormat();
        // The blank paper after the last note: the click lands as late as a whole hole fits.
        const end = layout.pages[0].endTimeInSeconds;
        const note = freeNote(layout, end);
        const lastPoint = pointOf(layout, note, end - 0.001);
        clickAt(container, lastPoint.x, lastPoint.y);
        expect(dxfHoles(container)).toBe(total + 1);
        const addedSeconds = end - (THIRTY.holeDiameterMm / 2 + 0.5) / THIRTY.millimetersPerSecond;
        const longer = fitSingleStrip(loadSampleMidi(), THIRTY, DEFAULT_FORMAT, 'auto', new Set(), [added(note, addedSeconds)]);
        expect(longer.pageWidthMm).toBeGreaterThan(fitted.pageWidthMm);
        expect(sizes()).toEqual([String(longer.pageWidthMm), '70.1']);
        expect(await downloadAll(getByText)).toEqual(layoutFor([added(note, addedSeconds)], [], longer).drawings.map(createDxf));

        fireEvent.click(getByText('Restore all'));
        expect(dxfHoles(container)).toBe(total);
        expect(sizes()).toEqual([String(fitted.pageWidthMm), '70.1']);
        expect(button(getByText, 'Restore all').disabled).toBe(true);
        expect(await downloadAll(getByText)).toEqual(layout.drawings.map(createDxf));
    });

    it('too close to a hole on its line nothing is added, and the reason is shown', async () => {
        const { container, getByText, queryByText } = await loadSample();
        const layout = layoutFor();
        const total = layout.extraction.notes.length;
        const hole = layout.extraction.notes[4];
        // 2.6 mm after the hole on its line: beyond the hole's click margin (1.1 + 1.2 mm), within the
        // minimum gap (3 mm).
        clickEmpty(container, layout, hole.note, hole.timeSeconds + 2.6 / THIRTY.millimetersPerSecond);
        expect(dxfHoles(container)).toBe(total);
        expect(getByText(TOO_CLOSE_REASON)).toBeTruthy();
        expect(getByText('No holes added or deleted')).toBeTruthy();
        // The next action clears the message.
        clickEmpty(container, layout, hole.note, hole.timeSeconds);
        expect(queryByText(TOO_CLOSE_REASON)).toBeNull();
    });

    it('the note lines and the beat lines can be hidden and shown again, separately', async () => {
        const { container, getByLabelText } = await loadSample();
        expect(container.querySelectorAll('.mb-noteLine').length).toBe(THIRTY.supportedNotes.length);
        expect(container.querySelectorAll('.mb-noteLabel').length).toBe(THIRTY.supportedNotes.length);
        const beats = container.querySelectorAll('.mb-beatLine-quarter').length;
        expect(beats).toBeGreaterThan(10);
        fireEvent.click(getByLabelText('Note lines'));
        expect(container.querySelectorAll('.mb-noteLine').length).toBe(0);
        expect(container.querySelectorAll('.mb-beatLine-quarter').length).toBe(beats);
        fireEvent.click(getByLabelText('Beat lines'));
        expect(container.querySelectorAll('.mb-beatLine-quarter').length).toBe(0);
        fireEvent.click(getByLabelText('Note lines'));
        fireEvent.click(getByLabelText('Beat lines'));
        expect(container.querySelectorAll('.mb-noteLine').length).toBe(THIRTY.supportedNotes.length);
        expect(container.querySelectorAll('.mb-beatLine-quarter').length).toBe(beats);
    });

    it('while playing, the piano gets the added hole without restarting, and it also sounds at once', async () => {
        vi.spyOn(PianoPlayer, 'isSupported').mockReturnValue(true);
        const updated: unknown[] = [];
        vi.spyOn(PianoPlayer.prototype, 'updateSequence').mockImplementation((sequence, shift) => { updated.push([sequence, shift]); });
        vi.spyOn(PianoPlayer.prototype, 'getState').mockReturnValue('playing');
        const preview = vi.spyOn(PianoPlayer.prototype, 'previewNote').mockImplementation(async () => undefined);
        const { container } = await loadSample();
        const layout = layoutFor();
        const seconds = gapTime(layout);
        const note = freeNote(layout, seconds);
        clickEmpty(container, layout, note, seconds);
        expect(updated).toEqual([[buildGeneratedMusicBoxSequence(loadSampleMidi(), THIRTY,
            { transposeOutOfRangeNotes: true, includePercussion: false, trackSelection: 'auto', deletedNoteIds: new Set(), addedNotes: [added(note, seconds)] }), 0]]);
        expect(preview).toHaveBeenCalledTimes(1);
        expect(preview.mock.calls[0][0].note).toBe(note);
    });

    it('keeps the added holes when the profile changes (if the box plays the note) and forgets them when a file is loaded', async () => {
        const { container, getByText, findByText } = await loadSample();
        const layout = layoutFor();
        const seconds = gapTime(layout);
        // A note both boxes have.
        const fifteen = BuiltInProfiles['fifteenNote'];
        const note = [...THIRTY.supportedNotes].filter(n => fifteen.supportedNotes.includes(n)).sort((a, b) => b - a).find(n =>
            !layout.extraction.notes.some(h => h.note === n && Math.abs(h.timeSeconds - seconds) < 1))!;
        clickEmpty(container, layout, note, seconds);
        expect(getByText('1 hole added')).toBeTruthy();

        fireEvent.click(getByText('Paper/Music Box Settings'));
        fireEvent.click(getByText('Select profile...'));
        fireEvent.click(await findByText('15 Note'));
        const expected15 = layoutFor([added(note, seconds)], [], undefined, fifteen);
        expect(expected15.extraction.addedCount).toBe(1);
        expect(dxfHoles(container)).toBe(expected15.extraction.notes.length);
        expect(await downloadAll(getByText)).toEqual(expected15.drawings.map(createDxf));
        expect(getByText('1 hole added')).toBeTruthy();
        expect(container.querySelectorAll('.mb-noteLine').length).toBe(fifteen.supportedNotes.length);

        pickFile(container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        await wait(() => expect(getByText('No holes added or deleted')).toBeTruthy());
        expect(button(getByText, 'Undo').disabled).toBe(true);
        expect(dxfHoles(container)).toBe(layoutFor([], [], undefined, fifteen).extraction.notes.length);
    });

    it('deleting the first holes keeps an added hole with the music', async () => {
        const { container, getByText } = await loadSample();
        const layout = layoutFor();
        const notes = layout.extraction.notes;
        const seconds = gapTime(layout);
        const note = freeNote(layout, seconds);
        clickEmpty(container, layout, note, seconds);
        const withAdded = layoutFor([added(note, seconds)]);
        // Remove every hole at the first time of the song (a chord: they don't move until the last one goes).
        const first = notes.filter(n => n.timeSeconds === notes[0].timeSeconds).map(n => n.id);
        first.forEach(id => {
            const index = withAdded.holeNotes[0].findIndex(n => n.id === id);
            const circle = parseDxf(createDxf(withAdded.drawings[0])).circles[index];
            clickAt(container, circle.cx, circle.cy);
        });
        const after = layoutFor([added(note, seconds)], first);
        expect(after.extraction.removedLeadingSeconds).toBeGreaterThan(0);
        const moved = after.extraction.notes.find(n => n.id === 'added:1')!;
        expect(moved.timeSeconds).toBeCloseTo(seconds - after.extraction.removedLeadingSeconds, 9);
        expect(getByText(/^\d+ holes? deleted · 1 hole added$/)).toBeTruthy();
        expect(await downloadAll(getByText)).toEqual(after.drawings.map(createDxf));
    });
});

describe('MusicBoxSheetGenerator: playback line', () => {
    const THIRTY = BuiltInProfiles['thirtyNote'];
    const PX_PER_MM = 10;
    let frames: FrameRequestCallback[];

    beforeEach(() => {
        vi.stubGlobal('AudioContext', FakeAudioContext);
        frames = [];
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length; });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    const runFrame = () => {
        const pending = frames;
        frames = [];
        act(() => pending.forEach(callback => callback(0)));
    };
    const layoutFor = (format = fittedFormat()) => computeMusicBoxLayout(loadSampleMidi(), THIRTY, format);
    const sequence = () => buildGeneratedMusicBoxSequence(loadSampleMidi(), THIRTY,
        { transposeOutOfRangeNotes: true, includePercussion: false, trackSelection: 'auto' });
    /** Notes of the fake audio context after `from` (index of its oscillators), as [note, start]. */
    const notesFrom = (from: number) => {
        const oscillators = fakeAudioContext().oscillators.slice(from);
        const notes: Array<[number, number]> = [];
        for (let i = 0; i < oscillators.length; i += 4) {
            if (!oscillators[i].stopped) {
                notes.push([Math.round(69 + 12 * Math.log2(oscillators[i].frequency.value / 440)), oscillators[i].startAt as number]);
            }
        }
        return notes;
    };

    async function loadSample() {
        const utils = render(<MusicBoxSheetGenerator />);
        pickFile(utils.container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        await utils.findByText('MIDI ready');
        placeSheets(utils.container);
        return utils;
    }
    /** jsdom has no layout: each sheet is drawn at 10 px per mm at the top-left corner. */
    function placeSheets(container: HTMLElement) {
        container.querySelectorAll('.mb-musicBoxSvgWrapper svg').forEach(element => {
            const svg = element as SVGSVGElement;
            svg.getBoundingClientRect = () => {
                const [, , w, h] = svg.getAttribute('viewBox')!.split(' ').map(Number);
                return { left: 0, top: 0, x: 0, y: 0, width: w * PX_PER_MM, height: h * PX_PER_MM, right: w * PX_PER_MM, bottom: h * PX_PER_MM, toJSON: () => ({}) } as DOMRect;
            };
        });
    }
    function shownLine(container: HTMLElement) {
        const group = Array.from(container.querySelectorAll('.mb-playhead')).find(g => (g as SVGGElement).style.display !== 'none')!;
        expect(group).toBeTruthy();
        const line = group.querySelector('.mb-playheadLine')!;
        const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map(a => Number(line.getAttribute(a)));
        return { x1, y1, x2, y2 };
    }
    /** Drags the line (of a vertical strip) from where it is to the moment `seconds`. */
    function dragLineTo(container: HTMLElement, layout: IMusicBoxLayout, seconds: number) {
        const hit = container.querySelector('.mb-playheadHit')!;
        const from = shownLine(container);
        const x = (from.x1 + from.x2) / 2;
        const to = playheadAt(layout, seconds)!.line;
        fireEvent.pointerDown(hit, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: x * PX_PER_MM, clientY: from.y1 * PX_PER_MM });
        fireEvent.pointerMove(hit, { pointerId: 1, pointerType: 'mouse', clientX: x * PX_PER_MM, clientY: to.y1 * PX_PER_MM });
        return async () => {
            fireEvent.pointerUp(hit, { pointerId: 1, pointerType: 'mouse', clientX: x * PX_PER_MM, clientY: to.y1 * PX_PER_MM });
            // The click that ends a drag is ignored only within the same moment.
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
        };
    }
    /** Moves the audio clock and lets the piano schedule its next notes. */
    async function advanceAudio(seconds: number) {
        fakeAudioContext().currentTime += seconds;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    }

    it('starts at the beginning of the song; dragged while stopped, the holes crossed sound and Play starts from the line', async () => {
        vi.spyOn(PianoPlayer, 'isSupported').mockReturnValue(true);
        const { container, getByText } = await loadSample();
        const layout = layoutFor();
        // Song time 0, where Play has always started.
        expect(shownLine(container).y1).toBeCloseTo(playheadAt(layout, 0)!.line.y1, 9);

        const notes = layout.extraction.notes;
        const target = notes[5].timeSeconds + 0.01;
        const release = dragLineTo(container, layout, target);
        await wait(() => expect(fakeAudioContext()).toBeTruthy());
        // The holes crossed (notes 0 to 5) sound once, right away; the piano stays stopped.
        await wait(() => expect(notesFrom(0).length).toBe(Math.min(6, notes.filter(n => n.timeSeconds <= target).length)));
        expect(notesFrom(0).every(([, start]) => start === 0)).toBe(true);
        expect(getByText('Play generated piano')).toBeTruthy();
        await release();
        expect(shownLine(container).y1).toBeCloseTo(playheadAt(layout, target)!.line.y1, 9);

        const before = fakeAudioContext().oscillators.length;
        const playAt = fakeAudioContext().currentTime;
        fireEvent.click(getByText('Play generated piano'));
        await wait(() => expect(getByText('Pause piano')).toBeTruthy());
        await advanceAudio(2);
        // From the line: the next note (notes[6]) is the first one, START_DELAY_SECONDS after Play.
        const next = sequence().filter(e => e.startTimeSeconds >= target);
        expect(notesFrom(before)[0]).toEqual([next[0].note, expect.closeTo(playAt + START_DELAY_SECONDS + next[0].startTimeSeconds - target, 9)]);
        expect(notesFrom(before).length).toBeGreaterThan(0);
        expect(notesFrom(before).some(([, start]) => start < playAt + START_DELAY_SECONDS - 1e-9)).toBe(false);
    });

    it('grabbing the line while playing pauses the piano; it goes on only with the play button, from where the line was left', async () => {
        vi.spyOn(PianoPlayer, 'isSupported').mockReturnValue(true);
        const { container, getByText, queryByText } = await loadSample();
        const layout = layoutFor();
        fireEvent.click(getByText('Play generated piano'));
        await wait(() => expect(getByText('Pause piano')).toBeTruthy());
        fakeAudioContext().currentTime = 1.1; // song time 1.0 s
        runFrame();
        expect(shownLine(container).y1).toBeCloseTo(playheadAt(layout, 1.0)!.line.y1, 6);

        const target = layout.extraction.notes[8].timeSeconds - 0.02;
        const release = dragLineTo(container, layout, target);
        await wait(() => expect(getByText('Play generated piano')).toBeTruthy());
        expect(queryByText('Pause piano')).toBeNull();
        await release();
        // Still paused after letting go, with the line where it was dropped.
        expect(fakeAudioContext().state).not.toBe('closed');
        expect(getByText('Play generated piano')).toBeTruthy();
        await wait(() => expect(shownLine(container).y1).toBeCloseTo(playheadAt(layout, target)!.line.y1, 9));

        const before = fakeAudioContext().oscillators.length;
        const resumeAt = fakeAudioContext().currentTime;
        fireEvent.click(getByText('Play generated piano'));
        await wait(() => expect(getByText('Pause piano')).toBeTruthy());
        await advanceAudio(1);
        const next = sequence().filter(e => e.startTimeSeconds >= target);
        expect(notesFrom(before)[0]).toEqual([next[0].note, expect.closeTo(resumeAt + START_DELAY_SECONDS + next[0].startTimeSeconds - target, 9)]);
    });

    it('when the song ends the line goes back to the start; Restart always starts from the beginning', async () => {
        vi.spyOn(PianoPlayer, 'isSupported').mockReturnValue(true);
        // Timers that also follow real time, to jump to the end of the song.
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { container, getByText } = await loadSample();
        const layout = layoutFor();
        await dragLineTo(container, layout, 10)();
        expect(shownLine(container).y1).toBeCloseTo(playheadAt(layout, 10)!.line.y1, 9);

        const before = fakeAudioContext().oscillators.length;
        const playAt = fakeAudioContext().currentTime;
        fireEvent.click(getByText('Restart piano'));
        await wait(() => expect(getByText('Pause piano')).toBeTruthy());
        await advanceAudio(1);
        expect(notesFrom(before)[0]).toEqual([sequence()[0].note, expect.closeTo(playAt + START_DELAY_SECONDS + sequence()[0].startTimeSeconds, 9)]);

        // The end of the song (the player stops by itself).
        fakeAudioContext().currentTime = 1000;
        act(() => { vi.advanceTimersByTime(1000 * 1000); });
        expect(getByText('Play generated piano')).toBeTruthy();
        expect(shownLine(container).y1).toBeCloseTo(playheadAt(layout, 0)!.line.y1, 9);
    });

    it('a setting that stops the piano puts the line back at the start, drawn across the strips as they are now', async () => {
        const { container, getByText, getByRole } = await loadSample();
        const layout = layoutFor();
        await dragLineTo(container, layout, 6)();
        expect(shownLine(container).y1).toBeCloseTo(playheadAt(layout, 6)!.line.y1, 9);
        fireEvent.click(getByText('Layout/Pagination'));
        const panel = within(getByRole('tabpanel'));
        fireEvent.click(panel.getByLabelText(/Horizontal/));
        fireEvent.click(panel.getAllByText('Apply')[0]);
        // The orientation doesn't change the sizes (no refit).
        const horizontal = layoutFor({ ...fittedFormat(), stripOrientation: 'horizontal' });
        const line = shownLine(container);
        const expected = playheadAt(horizontal, 0)!.line;
        // Horizontal strip: a vertical line at song time 0.
        expect(line.x1).toBe(line.x2);
        expect(line.x1).toBeCloseTo(expected.x1, 9);
    });

    it('deleting the first holes while stopped keeps the dragged line at the same point of the music', async () => {
        const { container } = await loadSample();
        const layout = layoutFor();
        const notes = layout.extraction.notes;
        const target = notes[10].timeSeconds;
        await dragLineTo(container, layout, target)();
        const first = notes.filter(n => n.timeSeconds === notes[0].timeSeconds).map(n => n.id);
        const removed = layoutFor().extraction.notes.find(n => !first.includes(n.id))!.timeSeconds - notes[0].timeSeconds;
        // Click the first hole(s): each click removes one.
        const circles = parseDxf(createDxf(layout.drawings[0])).circles;
        const svg = container.querySelector('.mb-musicBoxSvgWrapper svg')!;
        first.forEach(id => {
            const circle = circles[layout.holeNotes[0].findIndex(n => n.id === id)];
            fireEvent.click(svg, { clientX: circle.cx * PX_PER_MM, clientY: circle.cy * PX_PER_MM });
        });
        const after = computeMusicBoxLayout(loadSampleMidi(), THIRTY,
            fitSingleStrip(loadSampleMidi(), THIRTY, DEFAULT_FORMAT, 'auto', new Set(first)), 'auto', new Set(first));
        placeSheets(container);
        // The same note is under the line.
        const sameNote = after.extraction.notes.find(n => n.id === notes[10].id)!;
        expect(sameNote.timeSeconds).toBeCloseTo(target - removed, 9);
        expect(shownLine(container).y1).toBeCloseTo(playheadAt(after, sameNote.timeSeconds)!.line.y1, 9);
    });
});
