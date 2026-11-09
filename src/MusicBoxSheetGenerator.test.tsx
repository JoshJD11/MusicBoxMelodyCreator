import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, fireEvent, cleanup, within, wait } from '@testing-library/react';
import MusicBoxSheetGenerator from './MusicBoxSheetGenerator';
import MidiFile from './model/MidiFile';
import { BuiltInProfiles } from './model/IMusicBoxProfile';
import { computeMusicBoxLayout, fitSingleStrip } from './utilities/MusicBoxLayout';
import { IMusicBoxSvgFormatOptions } from './model/IMusicBoxSvgFormatOptions';
import { buildMidi, endOfTrack, noteOff, noteOn } from './testUtils/midiBuilder';
import { createDxf } from './utilities/DxfExporter';
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
        expect(container.querySelectorAll('.mb-musicBoxSvgWrapper circle').length).toBe(layout.extraction.notes.length);

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

        // Horizontal sheets: the preview is not limited in height.
        expect(container.querySelector('.mb-musicBoxSvgPages-limited')).toBeNull();
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
        expect(container.querySelectorAll('.mb-musicBoxSvgWrapper line').length).toBe(0);

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
    const circles = (container: HTMLElement) => container.querySelectorAll('.mb-musicBoxSvgWrapper circle').length;
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
