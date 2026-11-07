import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, fireEvent, cleanup, within } from '@testing-library/react';
import MusicBoxSheetGenerator from './MusicBoxSheetGenerator';
import MidiFile from './model/MidiFile';
import { BuiltInProfiles } from './model/IMusicBoxProfile';
import { computeMusicBoxLayout } from './utilities/MusicBoxLayout';
import { createDxf } from './utilities/DxfExporter';

const SAMPLE = 'You are my sunshine.mid';
const DEFAULT_FORMAT = {
    pageWidthMm: 250, pageHeightMm: 200, startPaddingMm: 10, renderBorder: true, omitPageBoundaries: false,
    transposeOutOfRangeNotes: true, includePercussion: false, jigsawJoiners: false, loopMode: false,
};

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

        // The preview shows one SVG per sheet.
        const midiFile = new MidiFile();
        const bytes = sampleBytes();
        midiFile.loadFromBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        const layout = computeMusicBoxLayout(midiFile, BuiltInProfiles['thirtyNote'], DEFAULT_FORMAT);
        const sheets = container.querySelectorAll('.mb-musicBoxSvgWrapper svg');
        expect(sheets.length).toBe(layout.sheets.length);
        expect(container.querySelectorAll('.mb-musicBoxSvgWrapper circle').length).toBe(layout.extraction.notes.length);

        fireEvent.click(getByText('Download DXF(s)'));
        expect(createdBlobs.length).toBe(layout.sheets.length);
        const downloaded = await Promise.all(createdBlobs.map(readBlob));
        expect(downloaded).toEqual(layout.sheets.map(createDxf));
    });

    it('shows a readable error for a file that is not MIDI', async () => {
        const { container, findByText, getByText } = render(<MusicBoxSheetGenerator />);
        pickFile(container, new File(['hello'], 'notes.mid', { type: 'audio/midi' }));
        await findByText('This file could not be loaded');
        expect(getByText(/Not a valid MIDI file/)).toBeTruthy();
        expect(getByText('No MIDI loaded')).toBeTruthy();
    });

    it('keeps unapplied settings when switching tabs, and only mounts the 3D view while open', () => {
        const { container, getByText, getByLabelText } = render(<MusicBoxSheetGenerator />);
        const tab = (name: string) => fireEvent.click(getByText(name));

        tab('Layout/Pagination');
        const mirror = getByLabelText(/Mirror strips vertically/) as HTMLInputElement;
        expect(mirror.checked).toBe(false);
        fireEvent.click(mirror);
        expect(mirror.checked).toBe(true);

        tab('MIDI File');
        tab('Paper/Music Box Settings');
        tab('Layout/Pagination');
        expect((getByLabelText(/Mirror strips vertically/) as HTMLInputElement).checked).toBe(true);

        // The experimental 3D view (WebGL) is not mounted while its tab is closed.
        expect(container.textContent).not.toContain('Load a MIDI file to generate layout');
        tab('3D Fischer Price (experimental)');
        expect(container.textContent).toContain('Load a MIDI file to generate layout');
        tab('MIDI File');
        expect(container.textContent).not.toContain('Load a MIDI file to generate layout');
    });

    it('warns about unapplied changes, and only uses applied values for the DXF', async () => {
        const { container, findByText, getByText, getByRole, queryByText } = render(<MusicBoxSheetGenerator />);
        pickFile(container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        await findByText('MIDI ready');

        fireEvent.click(getByText('Layout/Pagination'));
        const panel = () => within(getByRole('tabpanel'));
        const widthInput = () => numericInput(panel().getByText(/Max strip length/));
        const extMaxWidth = (dxf: string) => dxf.split('\r\n')[21]; // value after "$EXTMAX", "10"
        const downloadFirst = async () => {
            createdBlobs.length = 0;
            fireEvent.click(getByText('Download DXF(s)'));
            return readBlob(createdBlobs[0]);
        };

        fireEvent.change(widthInput(), { target: { value: '190' } });
        expect(panel().getByText('Changes not applied yet')).toBeTruthy();
        expect(getByText(/Settings not applied yet: Layout\/Pagination/)).toBeTruthy();
        // Not applied: the DXF still uses the applied 250 mm.
        expect(extMaxWidth(await downloadFirst())).toBe('250');

        fireEvent.click(panel().getByText('Discard'));
        expect(widthInput().value).toBe('250');
        expect(queryByText('Changes not applied yet')).toBeNull();
        expect(queryByText(/Settings not applied yet/)).toBeNull();

        fireEvent.change(widthInput(), { target: { value: '190' } });
        fireEvent.click(panel().getAllByText('Apply')[0]);
        expect(queryByText(/Settings not applied yet/)).toBeNull();
        expect(extMaxWidth(await downloadFirst())).toBe('190');
    });

    it('disables the download while the settings make the strips impossible', async () => {
        const { container, findByText, getByText, getByRole } = render(<MusicBoxSheetGenerator />);
        pickFile(container, new File([sampleBytes()], SAMPLE, { type: 'audio/midi' }));
        await findByText('MIDI ready');
        const download = () => getByText('Download DXF(s)').closest('button') as HTMLButtonElement;
        expect(download().disabled).toBe(false);

        fireEvent.click(getByText('Layout/Pagination'));
        const panel = within(getByRole('tabpanel'));
        fireEvent.change(numericInput(panel.getByText(/Sheet height/)), { target: { value: '50' } }); // < 70.1 mm strip
        fireEvent.click(panel.getAllByText('Apply')[0]);
        expect(download().disabled).toBe(true);
        expect(download().title).toMatch(/Sheet height must be at least 70.10 mm/);

        fireEvent.change(numericInput(within(getByRole('tabpanel')).getByText(/Sheet height/)), { target: { value: '200' } });
        fireEvent.click(within(getByRole('tabpanel')).getAllByText('Apply')[0]);
        expect(download().disabled).toBe(false);
    });
});
