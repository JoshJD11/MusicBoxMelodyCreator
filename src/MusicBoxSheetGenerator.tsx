import React, { Suspense } from "react";
import "./MusicBoxSheetGenerator.css";
import {
  Button,
  ButtonGroup,
  Card,
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
}

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
      showMidiJson: false,
      playbackState: "stopped",
    };
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
          onChange={(musicBoxSvgFormatOptions) => {
            this.player.stop();
            this.setState({ musicBoxSvgFormatOptions });
          }}
        />
      </div>
    );

    let fischerPriceSettings: JSX.Element;
    if (!this.state.midiFile) {
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
              renderActiveTabPanelOnly={true}
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
                panel={fischerPriceSettings}
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
    if (!this.state.midiFile) {
      return;
    }

    let sheets: ISheet[];
    try {
      sheets = computeMusicBoxLayout(
        this.state.midiFile,
        this.state.musicBoxProfile,
        this.state.musicBoxSvgFormatOptions,
        this.state.trackSelection
      ).sheets;
    } catch {
      // The preview already shows the error.
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
