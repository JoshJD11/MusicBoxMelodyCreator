import React, { Suspense } from "react";
import "./MusicBoxSheetGenerator.css";
import {
  Button,
  ButtonGroup,
  Callout,
  Card,
  Intent,
  Collapse,
  NonIdealState,
  Pre,
  Spinner,
  Tab,
  Tabs,
} from "@blueprintjs/core";
import MidiFilePicker from "./components/MidiFilePicker";
import MusicBoxSvg from "./components/MusicBoxSvg";
import { MusicBoxProfileEditor } from "./components/MusicBoxProfileEditor";
import { MusicBoxSvgFormatEditor } from "./components/MusicBoxSvgFormatEditor";
import MidiFile from "./model/MidiFile";
import { IMusicBoxSvgFormatOptions } from "./model/IMusicBoxSvgFormatOptions";
import { BuiltInProfiles, IMusicBoxProfile } from "./model/IMusicBoxProfile";
import MidiJsonConverter from "./utilities/MidiJsonConverter";
import { buildGeneratedMusicBoxSequence } from "./utilities/MusicBoxMidi";
import { TrackSelection } from "./utilities/MusicBoxNotes";
import { computeMusicBoxLayout, ISheet } from "./utilities/MusicBoxLayout";
import { createDxf } from "./utilities/DxfExporter";
import PianoPlayer, { PlaybackState } from "./utilities/PianoPlayer";

// three.js is large: the experimental 3D view is only downloaded when its tab is opened.
const FischerPrice3DModel = React.lazy(() => import("./components/FischerPrice3DModel"));

const CREDITS = [
  {
    asset: "Midi Icon",
    by: "Midi Synthesizer by Iconic from the Noun Project",
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

type SettingsTab = "file-picker-tab" | "paper-settings-tab" | "format-settings-tab" | "3d-printing-tab";

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
    result: { sheets?: ISheet[]; error?: string };
  };

  /** Layout of the current settings (cached while they don't change). */
  private getLayout(): { sheets?: ISheet[]; error?: string } | null {
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
    let result: { sheets?: ISheet[]; error?: string };
    try {
      result = { sheets: computeMusicBoxLayout(midiFile, musicBoxProfile, musicBoxSvgFormatOptions, trackSelection).sheets };
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
          <span>{x.by}</span>
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
          trackSelection={this.state.trackSelection}
          includePercussion={
            !!this.state.musicBoxSvgFormatOptions.includePercussion
          }
          onTrackSelectionChange={(trackSelection) => {
            this.player.stop();
            this.setState({ trackSelection });
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
            this.setState({ musicBoxProfile });
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
            this.setState({ musicBoxSvgFormatOptions });
          }}
        />
      </div>
    );

    let fischerPriceSettings: JSX.Element | null;
    if (this.state.selectedTab !== "3d-printing-tab") {
      // The settings panels stay mounted (so that unapplied edits survive a tab switch), but the
      // 3D view only exists while its tab is open: it keeps WebGL and an animation loop running.
      fischerPriceSettings = null;
    } else if (!this.state.midiFile) {
      fischerPriceSettings = (
        <div className="mb-settingsTab-container mb-settingsArea">
          <Card>
            <NonIdealState
              icon={"error"}
              title="No file loaded"
              description={"Load a MIDI file to generate layout"}
              action={undefined}
            />
          </Card>
        </div>
      );
    } else {
      fischerPriceSettings = (
        <Suspense fallback={<Spinner />}>
          <FischerPrice3DModel
            midiFile={this.state.midiFile}
            musicBoxProfile={this.state.musicBoxProfile}
          />
        </Suspense>
      );
    }

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
              renderActiveTabPanelOnly={false}
            >
              <Tab id="file-picker-tab" title="MIDI File" panel={filePicker} />
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
              <Tab
                id="3d-printing-tab"
                title="3D Fischer Price (experimental)"
                panel={fischerPriceSettings ?? undefined}
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
                <span className="mb-pageTag">SVG PREVIEW</span>
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
                <MusicBoxSvg
                  musicBoxProfile={this.state.musicBoxProfile}
                  formatting={this.state.musicBoxSvgFormatOptions}
                  midiFile={this.state.midiFile}
                  trackSelection={this.state.trackSelection}
                />
              </div>
            </main>
          ) : (
            <main className="mb-mainPanel mb-emptyPanel">
              <div className="mb-emptyContent">
                <p className="mb-eyebrow">YOUR NEXT MELODY</p>
                <h2>A little tune,<br />made tangible.</h2>
                <p className="mb-emptyCopy">Load a MIDI file to turn its notes into a music box paper strip.</p>
                <div className="mb-scoreRule" aria-hidden="true">
                  <span className="mb-scoreNote mb-scoreNote-one" />
                  <span className="mb-scoreNote mb-scoreNote-two" />
                  <span className="mb-scoreNote mb-scoreNote-three" />
                  <span className="mb-scoreNote mb-scoreNote-four" />
                </div>
                <span className="mb-emptyHint">MIDI files only <i /> Drag and drop is supported</span>
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
    this.setState({
      midiFile,
      fileName,
      midiJson: MidiJsonConverter.GetJson(midiFile),
      trackSelection: "auto",
    });
  }

  private downloadDxfs() {
    const layout = this.getLayout();
    const sheets = layout && layout.sheets;
    if (!sheets) {
      // The preview shows the error and the button is disabled.
      return;
    }

    const sourceFileName = this.state.fileName || "musicBox";
    const baseFileName = sourceFileName
      .replace(/\.(midi|mid)$/i, "")
      .replace(/[<>:"/\\|?*]/g, "_");

    sheets.forEach((sheet, i) => {
      downloadTextFile(
        createDxf(sheet),
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
