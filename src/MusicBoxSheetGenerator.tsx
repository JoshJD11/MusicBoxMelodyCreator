import React from "react";
import "./MusicBoxSheetGenerator.css";
import {
  Button,
  ButtonGroup,
  Callout,
  Intent,
  Collapse,
  Pre,
  Tab,
  Tabs,
} from "@blueprintjs/core";
import MidiFilePicker from "./components/MidiFilePicker";
import DxfPreview, { IStripFiles } from "./components/DxfPreview";
import { MusicBoxProfileEditor } from "./components/MusicBoxProfileEditor";
import { MusicBoxSvgFormatEditor } from "./components/MusicBoxSvgFormatEditor";
import MidiFile from "./model/MidiFile";
import { IMusicBoxSvgFormatOptions, shouldRefitSheet } from "./model/IMusicBoxSvgFormatOptions";
import { BuiltInProfiles, IMusicBoxProfile } from "./model/IMusicBoxProfile";
import MidiJsonConverter from "./utilities/MidiJsonConverter";
import { buildGeneratedMusicBoxSequence } from "./utilities/MusicBoxMidi";
import { TrackSelection } from "./utilities/MusicBoxNotes";
import { computeMusicBoxLayout, fitSingleStrip } from "./utilities/MusicBoxLayout";
import { createDxf } from "./utilities/DxfExporter";
import PianoPlayer, { PlaybackState } from "./utilities/PianoPlayer";

const CREDITS: { asset: string; by: string; url?: string }[] = [
  {
    asset: "Midi Icon",
    by: "Midi Synthesizer by Iconic from the Noun Project",
  },
  {
    asset: "MP3 to MIDI",
    by: "Basic Pitch by Spotify (Apache License 2.0)",
    url: "https://github.com/spotify/basic-pitch-ts",
  },
];

const DEFAULT_FORMAT_OPTIONS: IMusicBoxSvgFormatOptions = {
  pageWidthMm: 250,
  pageHeightMm: 200,
  startPaddingMm: 10,
  renderBorder: true,
  omitPageBoundaries: false,
  transposeOutOfRangeNotes: true,
  includePercussion: false,
  jigsawJoiners: false,
  loopMode: false,
  mirrorVertically: false,
  stripOrientation: "vertical",
};

interface IAppState {
  midiJson: string;
  fileName?: string;
  midiFile?: MidiFile;
  musicBoxProfile: IMusicBoxProfile;
  musicBoxSvgFormatOptions: IMusicBoxSvgFormatOptions;
  trackSelection: TrackSelection;
  showMidiJson: boolean;
  playbackState: PlaybackState;
  selectedTab: SettingsTab;
  /** Settings panels with edited values that have not been applied yet. */
  unappliedPaper: boolean;
  unappliedLayout: boolean;
}

type SettingsTab = "file-picker-tab" | "paper-settings-tab" | "format-settings-tab";

type AppProps = Record<string, never>;

export default class MusicBoxSheetGenerator extends React.Component<
  AppProps,
  IAppState
> {
  private readonly player = new PianoPlayer((playbackState) =>
    this.setState({ playbackState })
  );

  constructor(props: AppProps) {
    super(props);

    this.state = {
      midiJson: "",
      musicBoxProfile: BuiltInProfiles["thirtyNote"],
      musicBoxSvgFormatOptions: DEFAULT_FORMAT_OPTIONS,
      trackSelection: "auto",
      selectedTab: "file-picker-tab",
      unappliedPaper: false,
      unappliedLayout: false,
      showMidiJson: false,
      playbackState: "stopped",
    };
  }

  // Stable callbacks: the editors report changes from an effect.
  private readonly onPaperDirtyChange = (unappliedPaper: boolean) =>
    this.setState({ unappliedPaper });
  private readonly onLayoutDirtyChange = (unappliedLayout: boolean) =>
    this.setState({ unappliedLayout });

  private layoutCache?: {
    inputs: [MidiFile, IMusicBoxProfile, IMusicBoxSvgFormatOptions, TrackSelection];
    result: IStripFiles;
  };

  /**
   * Layout and DXF documents for the current settings, computed once (cached while the settings
   * don't change): the preview draws these documents and the download saves them.
   */
  private getLayout(): IStripFiles | null {
    const { midiFile, musicBoxProfile, musicBoxSvgFormatOptions, trackSelection } = this.state;
    if (!midiFile) {
      return null;
    }
    const inputs: [MidiFile, IMusicBoxProfile, IMusicBoxSvgFormatOptions, TrackSelection] =
      [midiFile, musicBoxProfile, musicBoxSvgFormatOptions, trackSelection];
    const cached = this.layoutCache;
    if (cached && cached.inputs.every((value, i) => value === inputs[i])) {
      return cached.result;
    }
    let result: IStripFiles;
    try {
      const layout = computeMusicBoxLayout(midiFile, musicBoxProfile, musicBoxSvgFormatOptions, trackSelection);
      result = { layout, dxfs: layout.drawings.map(createDxf) };
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    this.layoutCache = { inputs, result };
    return result;
  }

  public componentWillUnmount() {
    this.player.dispose();
  }

  render() {
    const credits = CREDITS.map((x, i) => {
      return (
        <div key={i}>
          <span>{x.asset}: </span>
          <span>{x.url ? <a href={x.url}>{x.by}</a> : x.by}</span>
        </div>
      );
    });

    const filePicker: JSX.Element = (
      <div className="mb-settingsTab-container">
        <MidiFilePicker
          fileName={this.state.fileName}
          midiFile={this.state.midiFile}
          onFileLoadStarted={() => this.onMidiDataLoadStarted()}
          onFileLoaded={(filename, midiFile) =>
            this.onMidiDataLoaded(filename, midiFile)
          }
          onFileReconverted={(midiFile) => this.onMidiDataReconverted(midiFile)}
          trackSelection={this.state.trackSelection}
          includePercussion={
            !!this.state.musicBoxSvgFormatOptions.includePercussion
          }
          onTrackSelectionChange={(trackSelection) => {
            this.player.stop();
            // Other notes, other length: the sheet is fitted again.
            this.setState((state) => ({
              trackSelection,
              musicBoxSvgFormatOptions: fitFormatToSong(
                state.midiFile, state.musicBoxProfile, state.musicBoxSvgFormatOptions, trackSelection),
            }));
          }}
        />
      </div>
    );

    const paperSettings: JSX.Element = (
      <div className="mb-settingsTab-container">
        <MusicBoxProfileEditor
          profile={this.state.musicBoxProfile}
          onDirtyChange={this.onPaperDirtyChange}
          onChange={(musicBoxProfile) => {
            this.player.stop();
            // Any paper setting can change the strip's length or width: the sheet is fitted again,
            // even over sizes typed by hand.
            this.setState((state) => ({
              musicBoxProfile,
              musicBoxSvgFormatOptions: fitFormatToSong(
                state.midiFile, musicBoxProfile, state.musicBoxSvgFormatOptions, state.trackSelection),
            }));
          }}
        />
      </div>
    );

    const formatSettings = (
      <div className="mb-settingsTab-container">
        <MusicBoxSvgFormatEditor
          options={this.state.musicBoxSvgFormatOptions}
          onDirtyChange={this.onLayoutDirtyChange}
          onChange={(musicBoxSvgFormatOptions) => {
            this.player.stop();
            this.setState((state) => ({
              musicBoxSvgFormatOptions: shouldRefitSheet(state.musicBoxSvgFormatOptions, musicBoxSvgFormatOptions)
                ? fitFormatToSong(state.midiFile, state.musicBoxProfile, musicBoxSvgFormatOptions, state.trackSelection)
                : musicBoxSvgFormatOptions,
            }));
          }}
        />
      </div>
    );

    const isPlaying = this.state.playbackState === "playing";
    const layout = this.getLayout();
    const layoutError = layout ? layout.error : undefined;
    const unappliedPanels = [
      this.state.unappliedPaper ? "Paper/Music Box Settings" : null,
      this.state.unappliedLayout ? "Layout/Pagination" : null,
    ].filter((name): name is string => name !== null);

    return (
      <div className="mb-appRoot">
        <header className="mb-header">
          <div className="mb-brand">
            <span className="mb-brandMark" aria-hidden="true">M</span>
            <div>
              <p className="mb-eyebrow">MUSICBOX / MELODY LAB</p>
              <h1>Music box sheet studio</h1>
            </div>
          </div>
          <div className="mb-status">
            <span className={this.state.midiFile ? "mb-statusDot mb-statusDot-ready" : "mb-statusDot"} />
            {this.state.midiFile ? "MIDI ready" : "No MIDI loaded"}
          </div>
        </header>
        <div className="mb-workspace">
          <aside className="mb-settingsArea">
            <Tabs
              animate={true}
              id="settings-tabs"
              key={"settings-tabs"}
              selectedTabId={this.state.selectedTab}
              onChange={(tabId) => this.setState({ selectedTab: tabId as SettingsTab })}
              // Every settings panel stays mounted (hidden), so that unapplied edits survive a tab switch.
              renderActiveTabPanelOnly={false}
            >
              <Tab id="file-picker-tab" title="MIDI / MP3 File" panel={filePicker} />
              <Tab
                id="paper-settings-tab"
                title="Paper/Music Box Settings"
                panel={paperSettings}
              />
              <Tab
                id="format-settings-tab"
                title="Layout/Pagination"
                panel={formatSettings}
              />
            </Tabs>
          </aside>
          {this.state.midiFile ? (
            <main className="mb-mainPanel">
              <div className="mb-panelHeading">
                <div>
                  <p className="mb-eyebrow">PAPER SCORE</p>
                  <h2>{this.state.fileName}</h2>
                </div>
                <span className="mb-pageTag">DXF PREVIEW</span>
              </div>
              <div className="mb-musicBox-preview">
                <div className="mb-previewActions">
                  <ButtonGroup style={{ minWidth: 200 }}>
                    <Button
                      icon={"download"}
                      text={"Download DXF(s)"}
                      disabled={!!layoutError}
                      title={layoutError ? "Fix the settings first: " + layoutError : undefined}
                      onClick={() => this.downloadDxfs()}
                    />
                    <Button
                      icon={isPlaying ? "pause" : "play"}
                      text={isPlaying ? "Pause piano" : "Play generated piano"}
                      disabled={!PianoPlayer.isSupported()}
                      onClick={() => this.toggleGeneratedPiano()}
                    />
                    <Button
                      icon={"refresh"}
                      text={"Restart piano"}
                      disabled={!PianoPlayer.isSupported()}
                      onClick={() => this.playGeneratedPiano()}
                    />
                    <Button onClick={() => this.toggleDebugMessage()}>
                      {this.state.showMidiJson ? "Hide" : "Show"} MIDI JSON
                    </Button>
                    <Button icon={"export"} onClick={() => this.copyMidiJson()}>
                      Copy MIDI Json
                    </Button>
                  </ButtonGroup>
                  {unappliedPanels.length > 0 && (
                    <Callout intent={Intent.WARNING} className="mb-unappliedNotice">
                      Settings not applied yet: {unappliedPanels.join(", ")}. The preview, the piano
                      and the DXF use the last applied values.
                    </Callout>
                  )}
                  <Collapse isOpen={this.state.showMidiJson}>
                    <Pre className="mb-debugMessage">{this.state.midiJson}</Pre>
                  </Collapse>
                </div>
                {layout && (
                  <DxfPreview
                    files={layout}
                    paperWidthMm={this.state.musicBoxProfile.paperWidthMm}
                    limitHeight={this.state.musicBoxSvgFormatOptions.stripOrientation === "vertical"}
                  />
                )}
              </div>
            </main>
          ) : (
            <main className="mb-mainPanel mb-emptyPanel">
              <div className="mb-emptyContent">
                <p className="mb-eyebrow">YOUR NEXT MELODY</p>
                <h2>A little tune,<br />made tangible.</h2>
                <p className="mb-emptyCopy">Load a MIDI file to turn its notes into a music box paper strip. MP3 files also work (experimental), but a MIDI file is preferable.</p>
                <div className="mb-scoreRule" aria-hidden="true">
                  <span className="mb-scoreNote mb-scoreNote-one" />
                  <span className="mb-scoreNote mb-scoreNote-two" />
                  <span className="mb-scoreNote mb-scoreNote-three" />
                  <span className="mb-scoreNote mb-scoreNote-four" />
                </div>
                <span className="mb-emptyHint">MIDI or MP3 (experimental) <i /> Drag and drop is supported</span>
              </div>
              <div className="mb-emptyIndex">01 <span>/</span> CREATE</div>
            </main>
          )}
        </div>
        <footer className="mb-footer">
          <span>Made for melodies that deserve to be heard.</span>
          <div>
            Code: <a href="https://github.com/JoshJD11/MusicBoxMelodyCreator">GitHub</a>
            {" "}(based on <a href="https://github.com/SabinT/musicbox-svg">musicbox-svg</a>)
            <span className="mb-footerDivider">/</span>License:{" "}
            <a href="https://github.com/JoshJD11/MusicBoxMelodyCreator/blob/main/LICENSE">GPLv3</a>
            <span className="mb-footerDivider">/</span>Credits: {credits}
          </div>
        </footer>
      </div>
    );
  }

  private onMidiDataLoadStarted() {
    // The previous melody is dropped the moment another file is picked, before it
    // is even parsed, so that the layout and the piano can never show or render
    // the song that was loaded before.
    this.player.stop();
    this.setState({
      midiFile: undefined,
      fileName: undefined,
      midiJson: "",
    });
  }

  private onMidiDataLoaded(fileName: string, midiFile: MidiFile) {
    this.player.stop();
    this.setState((state) => ({
      midiFile,
      fileName,
      midiJson: MidiJsonConverter.GetJson(midiFile),
      trackSelection: "auto",
      // Every load (even of the same file) fits the sheet to the whole song on a single strip, with
      // the paper border drawn.
      musicBoxSvgFormatOptions: fitFormatToSong(
        midiFile, state.musicBoxProfile, { ...state.musicBoxSvgFormatOptions, renderBorder: true }, "auto"),
    }));
  }

  /** The notes of the loaded MP3 were detected again with other settings: other notes, other length. */
  private onMidiDataReconverted(midiFile: MidiFile) {
    this.player.stop();
    this.setState((state) => ({
      midiFile,
      midiJson: MidiJsonConverter.GetJson(midiFile),
      musicBoxSvgFormatOptions: fitFormatToSong(
        midiFile, state.musicBoxProfile, state.musicBoxSvgFormatOptions, state.trackSelection),
    }));
  }

  private downloadDxfs() {
    const layout = this.getLayout();
    const dxfs = layout && layout.dxfs;
    if (!dxfs) {
      // The preview shows the error and the button is disabled.
      return;
    }

    const sourceFileName = this.state.fileName || "musicBox";
    const baseFileName = sourceFileName
      .replace(/\.(midi|mid|mp3)$/i, "")
      .replace(/[<>:"/\\|?*]/g, "_");

    // Exactly the documents drawn in the preview.
    dxfs.forEach((dxf, i) => {
      downloadTextFile(
        dxf,
        `${baseFileName}_page_${i + 1}.dxf`,
        "application/dxf"
      );
    });
  }

  private copyMidiJson(): void {
    if (!navigator.clipboard) {
      return;
    }
    navigator.clipboard.writeText(this.state.midiJson).catch(() => {
      // Clipboard access can be denied by the browser; nothing else to do.
    });
  }

  private async toggleGeneratedPiano(): Promise<void> {
    switch (this.player.getState()) {
      case "playing":
        await this.player.pause();
        break;
      case "paused":
        await this.player.resume();
        break;
      default:
        await this.playGeneratedPiano();
    }
  }

  /** Plays, from the start, exactly the notes punched in the strip. */
  private async playGeneratedPiano(): Promise<void> {
    if (!this.state.midiFile) {
      return;
    }

    const sequence = buildGeneratedMusicBoxSequence(
      this.state.midiFile,
      this.state.musicBoxProfile,
      {
        transposeOutOfRangeNotes:
          this.state.musicBoxSvgFormatOptions.transposeOutOfRangeNotes,
        includePercussion: this.state.musicBoxSvgFormatOptions.includePercussion,
        trackSelection: this.state.trackSelection,
      }
    );

    await this.player.play(sequence);
  }

  private toggleDebugMessage(): void {
    this.setState((state) => ({ showMidiJson: !state.showMidiJson }));
  }
}

/**
 * Sizes that fit the whole song on one strip. Without a song, or if it can't be laid out (e.g. it
 * has no playable notes), the options are kept and the preview shows the error.
 */
function fitFormatToSong(
  midiFile: MidiFile | undefined,
  profile: IMusicBoxProfile,
  format: IMusicBoxSvgFormatOptions,
  trackSelection: TrackSelection
): IMusicBoxSvgFormatOptions {
  if (!midiFile) {
    return format;
  }
  try {
    return fitSingleStrip(midiFile, profile, format, trackSelection);
  } catch {
    return format;
  }
}

function downloadTextFile(content: string, fileName: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const downloadLink = document.createElement("a");
  downloadLink.href = url;
  downloadLink.download = fileName;
  document.body.appendChild(downloadLink);
  downloadLink.click();
  document.body.removeChild(downloadLink);
  // Revoking immediately can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
