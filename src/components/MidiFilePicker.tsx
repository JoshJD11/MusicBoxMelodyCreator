import './MidiFilePicker.css';
import * as React from 'react';
import { Card, FileInput, NonIdealState, H4, Callout, Text, HTMLSelect, Label, Intent, ProgressBar } from "@blueprintjs/core";
import MidiFile from '../model/MidiFile';
import { MidiNote } from '../model/MidiConstants';
import MidiNoteHistogram from './MidiNoteHistogram';
import { AudioTranscriptionPanel, ExperimentalAudioNotice } from './AudioTranscriptionPanel';
import { getTrackSummaries, resolveTrackIndices, TrackSelection } from '../utilities/MusicBoxNotes';
import {
    ACCEPTED_AUDIO_FILES,
    analysisToMidiFile,
    analyzeAudioFile,
    DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS,
    IAudioAnalysis,
    IAudioTranscriptionSettings,
    isAudioFile,
    TranscriptionCancelledError,
    TranscriptionProgress,
} from '../utilities/AudioTranscription';

const ACCEPTED_FILES = '.mid,.midi,audio/midi,audio/x-midi,' + ACCEPTED_AUDIO_FILES;

export interface IMidiFilePickerProps {
    fileName?: string;
    midiFile?: MidiFile;

    /** Called as soon as a file is picked, before it has been read and parsed. */
    onFileLoadStarted?(): void;

    /** Called with the parsed MIDI file (for an MP3, the MIDI file made from its notes). */
    onFileLoaded?(fileName: string, midiFile: MidiFile): void;

    /** Called when the notes of the loaded MP3 are detected again with other settings. */
    onFileReconverted?(midiFile: MidiFile): void;

    trackSelection: TrackSelection;
    includePercussion: boolean;
    onTrackSelectionChange(selection: TrackSelection): void;
}

/** The loaded MP3: Basic Pitch's analysis is kept to detect the notes again with other settings. */
interface IAudioSource {
    analysis: IAudioAnalysis;
    settings: IAudioTranscriptionSettings;
    noteCount: number;
    trimmedSeconds: number;
}

export interface IMidiFilePickerState {
    fileName?: string;
    midiFile?: MidiFile;
    /** Why the last file could not be loaded. */
    error?: string;
    /** Set while an MP3 is being converted. */
    conversion?: TranscriptionProgress;
    audio?: IAudioSource;
}

function readFile(file: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            if (reader.result instanceof ArrayBuffer) {
                resolve(reader.result);
            }
        };
        reader.onerror = () => reject(new Error('The file could not be read.'));
        reader.readAsArrayBuffer(file);
    });
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export default class MidiFilePicker extends React.Component<IMidiFilePickerProps, IMidiFilePickerState>{
    /** Incremented for every file picked: results of a previous file are ignored. */
    private loadId = 0;
    /** Incremented for every change of the MP3 settings: results of previous settings are ignored. */
    private reconvertId = 0;

    constructor(props: IMidiFilePickerProps) {
        super(props);
        this.state = {
            fileName: props.fileName,
            midiFile: props.midiFile
        };
    }

    public componentWillUnmount() {
        // Stops a running MP3 conversion and ignores its result.
        this.loadId++;
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
        // Browsers don't fire "change" when the same file is picked again (e.g. after editing
        // it): clear the input so that picking it again always reloads it.
        target.value = '';
    }

    private openFile(file: File) {
        const loadId = ++this.loadId;
        this.setState({ fileName: file.name, midiFile: undefined, error: undefined, conversion: undefined, audio: undefined });
        if (this.props.onFileLoadStarted) {
            this.props.onFileLoadStarted();
        }

        if (isAudioFile(file)) {
            this.openAudioFile(file, loadId);
            return;
        }

        readFile(file).then(buffer => {
            if (loadId !== this.loadId) {
                return; // Another file was picked meanwhile.
            }
            const midiFile = new MidiFile();
            try {
                midiFile.loadFromBuffer(buffer);
            } catch (error) {
                this.setState({ error: errorMessage(error) });
                return;
            }

            this.setState({ midiFile });
            if (this.props.onFileLoaded) {
                this.props.onFileLoaded(file.name, midiFile);
            }
        }, error => {
            if (loadId === this.loadId) {
                this.setState({ error: errorMessage(error) });
            }
        });
    }

    /** MP3: Basic Pitch detects its notes, which are loaded as a MIDI file. */
    private async openAudioFile(file: File, loadId: number) {
        const isCurrent = () => loadId === this.loadId;
        this.setState({ conversion: { stage: 'preparing' } });
        try {
            const data = await readFile(file);
            const analysis = await analyzeAudioFile(
                data,
                conversion => {
                    if (isCurrent()) {
                        this.setState({ conversion });
                    }
                },
                () => !isCurrent());
            const settings = { ...DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS };
            const { midiFile, noteCount, trimmedSeconds } = await analysisToMidiFile(analysis, settings);
            if (!isCurrent()) {
                return;
            }
            this.setState({ midiFile, conversion: undefined, audio: { analysis, settings, noteCount, trimmedSeconds } });
            if (this.props.onFileLoaded) {
                this.props.onFileLoaded(file.name, midiFile);
            }
        } catch (error) {
            if (isCurrent() && !(error instanceof TranscriptionCancelledError)) {
                this.setState({ conversion: undefined, error: errorMessage(error) });
            }
        }
    }

    private async changeAudioSettings(settings: IAudioTranscriptionSettings) {
        const audio = this.state.audio;
        if (!audio) {
            return;
        }
        const loadId = this.loadId;
        const reconvertId = ++this.reconvertId;
        this.setState({ audio: { ...audio, settings } });
        try {
            const { midiFile, noteCount, trimmedSeconds } = await analysisToMidiFile(audio.analysis, settings);
            if (loadId !== this.loadId || reconvertId !== this.reconvertId) {
                return;
            }
            this.setState({ midiFile, audio: { ...audio, settings, noteCount, trimmedSeconds } });
            if (this.props.onFileReconverted) {
                this.props.onFileReconverted(midiFile);
            }
        } catch (error) {
            if (loadId === this.loadId && reconvertId === this.reconvertId) {
                this.setState({ error: errorMessage(error) });
            }
        }
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

    private renderConversion(conversion: TranscriptionProgress): JSX.Element {
        const transcribing = conversion.stage === 'transcribing';
        return (
            <div className="mb-audioProgress" role="status">
                <p>
                    {transcribing
                        ? `Detecting the notes of the audio… ${Math.round(conversion.fraction * 100)}%`
                        : 'Preparing the audio and the note detection model…'}
                </p>
                <ProgressBar intent={Intent.PRIMARY} value={transcribing ? conversion.fraction : undefined} />
                <ExperimentalAudioNotice />
            </div>
        );
    }

    render() {
        const inputProps = { accept: ACCEPTED_FILES };
        const action = this.state.fileName
            ? <FileInput text={this.state.fileName} buttonText={'Replace'} inputProps={inputProps} onInputChange={(ev) => this.handleInputChange(ev)} />
            : <FileInput text={'Select a MIDI or MP3 file'} inputProps={inputProps} onInputChange={(ev) => this.handleInputChange(ev)} />;

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
        } else if (this.state.conversion) {
            content =
                <>
                    <H4><Text ellipsize={true}>{this.state.fileName}</Text></H4>
                    {action}
                    {this.renderConversion(this.state.conversion)}
                </>;
        } else if (this.state.midiFile) {
            const stats = this.state.midiFile.midiStats;
            const audio = this.state.audio;

            const tempoInfo = stats.tempos.length
                ? 'Tempo: ' + stats.tempos.map(x => parseFloat(x.toFixed(2))).join(', ') + ' bpm'
                : 'Tempo: 120 bpm (default)';

            content =
                <>
                    <H4><Text ellipsize={true}>{this.state.fileName}</Text></H4>
                    {action}
                    {audio && (
                        <AudioTranscriptionPanel
                            settings={audio.settings}
                            noteCount={audio.noteCount}
                            trimmedSeconds={audio.trimmedSeconds}
                            onChange={(settings) => this.changeAudioSettings(settings)}
                        />
                    )}
                    {this.renderTrackSelector(this.state.midiFile)}
                    <Callout>
                        {/* The tempo of a MIDI file made from audio means nothing. */}
                        {!audio && <p>{tempoInfo}; last note at {stats.lastNoteOnEventInSeconds.toFixed(2)} seconds </p>}
                        {audio && <p>Last note at {stats.lastNoteOnEventInSeconds.toFixed(2)} seconds</p>}
                        <p>High Note: {MidiNote[stats.highNote]}, Low Note: {MidiNote[stats.lowNote]} </p>
                    </Callout>
                    <MidiNoteHistogram width={320} height={80} midiStats={stats} />
                </>;
        } else {
            content = <NonIdealState
                icon={'import'}
                title='No file loaded'
                description={
                    <>
                        <p>Drag and drop or select a file below...</p>
                        <p className="mb-filePickerHint">
                            MIDI files give exact results and are preferable. MP3 files are experimental: their
                            notes are detected automatically, which works best with a melody played on piano or a
                            similar single instrument.
                        </p>
                    </>
                }
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
