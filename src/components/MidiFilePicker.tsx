import './MidiFilePicker.css';
import * as React from 'react';
import { Card, FileInput, NonIdealState, H4, Callout, Text, HTMLSelect, Label, Intent } from "@blueprintjs/core";
import MidiFile from '../model/MidiFile';
import { MidiNote } from '../model/MidiConstants';
import MidiNoteHistogram from './MidiNoteHistogram';
import { getTrackSummaries, resolveTrackIndices, TrackSelection } from '../utilities/MusicBoxNotes';

const ACCEPTED_FILES = '.mid,.midi,audio/midi,audio/x-midi';

export interface IMidiFilePickerProps {
    fileName?: string;
    midiFile?: MidiFile;

    /** Called as soon as a file is picked, before it has been read and parsed. */
    onFileLoadStarted?(): void;

    onFileLoaded?(fileName: string, midiFile: MidiFile): void;

    trackSelection: TrackSelection;
    includePercussion: boolean;
    onTrackSelectionChange(selection: TrackSelection): void;
}

export interface IMidiFilePickerState {
    fileName?: string;
    midiFile?: MidiFile;
    /** Why the last file could not be loaded. */
    error?: string;
}

export default class MidiFilePicker extends React.Component<IMidiFilePickerProps, IMidiFilePickerState>{
    constructor(props: IMidiFilePickerProps) {
        super(props);
        this.state = {
            fileName: props.fileName,
            midiFile: props.midiFile
        };
    }

    private dropHandler(ev: React.DragEvent) {
        // Prevent default behavior (Prevent file from being opened)
        ev.preventDefault();

        const file = ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (file) {
            this.openFile(file);
        }
    }

    private handleInputChange(event: React.FormEvent<HTMLInputElement>) {
        const target = event.currentTarget;
        if (target.files && target.files.length > 0 && target.files[0]) {
            this.openFile(target.files[0]);
        }
    }

    private openFile(file: File) {
        this.setState({ fileName: file.name, midiFile: undefined, error: undefined });
        if (this.props.onFileLoadStarted) {
            this.props.onFileLoadStarted();
        }

        const reader = new FileReader();
        reader.onload = () => {
            if (!(reader.result instanceof ArrayBuffer)) {
                return;
            }

            const midiFile = new MidiFile();
            try {
                midiFile.loadFromBuffer(reader.result);
            } catch (error) {
                this.setState({ error: error instanceof Error ? error.message : String(error) });
                return;
            }

            this.setState({ midiFile });
            if (this.props.onFileLoaded) {
                this.props.onFileLoaded(file.name, midiFile);
            }
        };
        reader.onerror = () => {
            this.setState({ error: 'The file could not be read.' });
        };

        reader.readAsArrayBuffer(file);
    }

    private dragOverHandler(ev: React.DragEvent) {
        // Prevent default behavior (Prevent file from being opened)
        ev.stopPropagation();
        ev.preventDefault();
    }

    private renderTrackSelector(midiFile: MidiFile): JSX.Element | null {
        const summaries = getTrackSummaries(midiFile, this.props.includePercussion);
        if (summaries.length < 2) {
            return null;
        }

        const autoTracks = resolveTrackIndices(midiFile, 'auto', this.props.includePercussion);
        const trackLabel = (index: number) => {
            const summary = summaries[index];
            return `Track ${index + 1}${summary.name ? ': ' + summary.name : ''} (${summary.noteCount} notes)`;
        };

        const options = [
            { value: 'auto', label: 'Auto' + (autoTracks.length ? ` - ${trackLabel(autoTracks[0])}` : '') },
            { value: 'all', label: 'All tracks merged' },
            ...summaries.map(s => ({ value: String(s.index), label: trackLabel(s.index) })),
        ];

        return (
            <Label>
                Track
                <HTMLSelect
                    fill={true}
                    value={String(this.props.trackSelection)}
                    options={options}
                    onChange={(ev) => {
                        const value = ev.currentTarget.value;
                        this.props.onTrackSelectionChange(
                            value === 'auto' || value === 'all' ? value : Number(value));
                    }}
                />
            </Label>
        );
    }

    render() {
        const inputProps = { accept: ACCEPTED_FILES };
        const action = this.state.fileName
            ? <FileInput text={this.state.fileName} buttonText={'Replace'} inputProps={inputProps} onInputChange={(ev) => this.handleInputChange(ev)} />
            : <FileInput text={'Select a MIDI file'} inputProps={inputProps} onInputChange={(ev) => this.handleInputChange(ev)} />;

        let content: JSX.Element;

        if (this.state.error) {
            content =
                <>
                    <H4><Text ellipsize={true}>{this.state.fileName}</Text></H4>
                    {action}
                    <Callout intent={Intent.DANGER} title="This file could not be loaded">
                        {this.state.error}
                    </Callout>
                </>;
        } else if (this.state.midiFile) {
            const stats = this.state.midiFile.midiStats;

            const tempoInfo = stats.tempos.length
                ? 'Tempo: ' + stats.tempos.map(x => parseFloat(x.toFixed(2))).join(', ') + ' bpm'
                : 'Tempo: 120 bpm (default)';

            content =
                <>
                    <H4><Text ellipsize={true}>{this.state.fileName}</Text></H4>
                    {action}
                    {this.renderTrackSelector(this.state.midiFile)}
                    <Callout>
                        <p>{tempoInfo}; last note at {stats.lastNoteOnEventInSeconds.toFixed(2)} seconds </p>
                        <p>High Note: {MidiNote[stats.highNote]}, Low Note: {MidiNote[stats.lowNote]} </p>
                    </Callout>
                    <MidiNoteHistogram width={320} height={80} midiStats={stats} />
                </>;
        } else {
            content = <NonIdealState
                icon={'import'}
                title='No file loaded'
                description={'Drag and drop or select a file below...'}
                action={action}
            />
        }

        return (
            <Card id={'drop_zone'}
                onDrop={(ev) => this.dropHandler(ev)}
                onDragOver={(ev) => this.dragOverHandler(ev)}
                className={'mb-midiFilePicker'}
            >
                {content}
            </Card>
        )
    }
}
