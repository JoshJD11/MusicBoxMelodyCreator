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
import { HoleEditToolbar } from "./components/HoleEditToolbar";
import { MusicBoxProfileEditor } from "./components/MusicBoxProfileEditor";
import { MusicBoxSvgFormatEditor } from "./components/MusicBoxSvgFormatEditor";
import MidiFile from "./model/MidiFile";
import { IMusicBoxSvgFormatOptions, shouldRefitSheet } from "./model/IMusicBoxSvgFormatOptions";
import { BuiltInProfiles, IMusicBoxProfile } from "./model/IMusicBoxProfile";
import MidiJsonConverter from "./utilities/MidiJsonConverter";
import { buildGeneratedMusicBoxSequence, IGeneratedMusicBoxEvent } from "./utilities/MusicBoxMidi";
import { TrackSelection } from "./utilities/MusicBoxNotes";
import { computeMusicBoxLayout, fitSingleStrip } from "./utilities/MusicBoxLayout";
import { createDxf } from "./utilities/DxfExporter";
import PianoPlayer, { PlaybackState } from "./utilities/PianoPlayer";
import {
  canUndoHoleEdit,
  deleteHoles,
  IHoleEdits,
  NO_HOLE_EDITS,
  restoreAllHoles,
  undoHoleEdit,
} from "./utilities/HoleEdits";

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

const NO_SELECTION: ReadonlySet<string> = new Set<string>();

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
  /**
   * Holes deleted by hand in the preview, with their undo history. They belong to the loaded file:
   * kept when the settings change, dropped when another file is loaded or the MP3's notes are
   * detected again.
   */
  holeEdits: IHoleEdits;
  /** Holes selected in the preview (note ids). */
  selectedHoles: ReadonlySet<string>;
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
      holeEdits: NO_HOLE_EDITS,
      selectedHoles: NO_SELECTION,
    };
  }

  // Stable callbacks: the editors report changes from an effect.
  private readonly onPaperDirtyChange = (unappliedPaper: boolean) =>
    this.setState({ unappliedPaper });
  private readonly onLayoutDirtyChange = (unappliedLayout: boolean) =>
    this.setState({ unappliedLayout });

  private layoutCache?: {
    inputs: LayoutInputs;
    result: IStripFiles;
  };

  /**
   * Layout and DXF documents for the current settings, computed once (cached while the settings
   * don't change): the preview draws these documents and the download saves them.
   */
  private getLayout(): IStripFiles | null {
    const { midiFile, musicBoxProfile, musicBoxSvgFormatOptions, trackSelection, holeEdits } = this.state;
    if (!midiFile) {
      return null;
    }
    const inputs: LayoutInputs =
      [midiFile, musicBoxProfile, musicBoxSvgFormatOptions, trackSelection, holeEdits.deleted];
    const cached = this.layoutCache;
    if (cached && cached.inputs.every((value, i) => value === inputs[i])) {
      return cached.result;
    }
    let result: IStripFiles;
    try {
      const layout = computeMusicBoxLayout(
        midiFile, musicBoxProfile, musicBoxSvgFormatOptions, trackSelection, holeEdits.deleted);
      result = { layout, dxfs: layout.drawings.map(createDxf) };
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    this.layoutCache = { inputs, result };
    return result;
  }

  public componentDidMount() {
    document.addEventListener("keydown", this.onKeyDown);
  }

  public componentWillUnmount() {
    document.removeEventListener("keydown", this.onKeyDown);
    this.player.dispose();
  }

  /**
   * Keyboard shortcuts of the hole editor: Backspace / Delete delete the selected holes, Esc
   * unselects them and Ctrl+Z (⌘Z) undoes. Not while typing in a field, where those keys edit the
   * text (its own undo included).
   */
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !this.state.midiFile || isTextEntry(event.target)) {
      return;
    }
    const commandKey = event.ctrlKey || event.metaKey;
    const key = event.key || "";
    if (commandKey && !event.shiftKey && !event.altKey && key.toLowerCase() === "z") {
      if (canUndoHoleEdit(this.state.holeEdits)) {
        event.preventDefault();
        this.undoHoleEdit();
      }
      return;
    }
    if (commandKey || event.altKey) {
      return;
    }
    if (key === "Backspace" || key === "Delete") {
      if (this.getSelectedHolesOnStrip().length > 0) {
        // Backspace also means "go back" in some browsers.
        event.preventDefault();
        this.deleteSelectedHoles();
      }
    } else if (key === "Escape" && this.state.selectedHoles.size > 0) {
      this.clearHoleSelection();
    }
  };

  /** Selected holes that are on the strip with the current settings. */
  private getSelectedHolesOnStrip(): string[] {
    const files = this.getLayout();
    const selected = this.state.selectedHoles;
    if (!files || !files.layout || selected.size === 0) {
      return [];
    }
    return files.layout.extraction.notes.map((note) => note.id).filter((id) => selected.has(id));
  }

  private readonly toggleHoleSelection = (noteId: string) => {
    this.setState((state) => {
      const selectedHoles = new Set(state.selectedHoles);
      if (!selectedHoles.delete(noteId)) {
        selectedHoles.add(noteId);
      }
      return { selectedHoles };
    });
  };

  private clearHoleSelection() {
    this.setState({ selectedHoles: NO_SELECTION });
  }

  private deleteSelectedHoles() {
    const ids = this.getSelectedHolesOnStrip();
    if (ids.length > 0) {
      this.applyHoleEdits(deleteHoles(this.state.holeEdits, ids));
    }
  }

  private undoHoleEdit() {
    this.applyHoleEdits(undoHoleEdit(this.state.holeEdits));
  }

  private restoreAllHoles() {
    this.applyHoleEdits(restoreAllHoles(this.state.holeEdits));
  }

  /**
   * Applies deleted / restored holes: the strip, the DXF and the piano change; a piano that is
   * playing (or paused) goes on from where it is with the new notes. If the sheet was fitted to the
   * song it is fitted again (the song can now be shorter or longer); sizes typed by hand are kept.
   */
  private applyHoleEdits(holeEdits: IHoleEdits) {
    if (holeEdits === this.state.holeEdits) {
      return;
    }
    this.setState(
      (state) => ({
        holeEdits,
        selectedHoles: NO_SELECTION,
        musicBoxSvgFormatOptions: refitAfterHoleEdits(state, holeEdits.deleted),
      }),
      () => {
        if (this.player.getState() !== "stopped") {
          this.player.updateSequence(this.buildPianoSequence());
        }
      }
    );
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
          deletedHoleCount={this.state.holeEdits.deleted.size}
          onTrackSelectionChange={(trackSelection) => {
            this.player.stop();
            // Other notes, other length: the sheet is fitted again.
            this.setState((state) => ({
              trackSelection,
              musicBoxSvgFormatOptions: fitFormatToSong(
                state.midiFile, state.musicBoxProfile, state.musicBoxSvgFormatOptions, trackSelection,
                state.holeEdits.deleted),
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
                state.midiFile, musicBoxProfile, state.musicBoxSvgFormatOptions, state.trackSelection,
                state.holeEdits.deleted),
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
                ? fitFormatToSong(state.midiFile, state.musicBoxProfile, musicBoxSvgFormatOptions,
                  state.trackSelection, state.holeEdits.deleted)
                : musicBoxSvgFormatOptions,
            }));
          }}
        />
      </div>
    );

    const isPlaying = this.state.playbackState === "playing";
    const layout = this.getLayout();
    const layoutError = layout ? layout.error : undefined;
    const holeEdits = this.state.holeEdits;
    const canUndoHoles = canUndoHoleEdit(holeEdits);
    // The toolbar stays when the strip can't be drawn only if a deletion can be undone or restored.
    const showHoleToolbar = !!layout && (!layoutError || canUndoHoles || holeEdits.deleted.size > 0);
    const holeToolbar = showHoleToolbar ? (
      <HoleEditToolbar
        selectedCount={this.getSelectedHolesOnStrip().length}
        deletedCount={layout && layout.layout ? layout.layout.extraction.deletedCount : holeEdits.deleted.size}
        canUndo={canUndoHoles}
        canRestore={holeEdits.deleted.size > 0}
        onDelete={() => this.deleteSelectedHoles()}
        onClearSelection={() => this.clearHoleSelection()}
        onUndo={() => this.undoHoleEdit()}
        onRestoreAll={() => this.restoreAllHoles()}
      />
    ) : undefined;
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
                    selectedHoleIds={this.state.selectedHoles}
                    onHoleClick={this.toggleHoleSelection}
                    toolbar={holeToolbar}
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
      holeEdits: NO_HOLE_EDITS,
      selectedHoles: NO_SELECTION,
    });
  }

  private onMidiDataLoaded(fileName: string, midiFile: MidiFile) {
    this.player.stop();
    this.setState((state) => ({
      midiFile,
      fileName,
      midiJson: MidiJsonConverter.GetJson(midiFile),
      trackSelection: "auto",
      // Holes deleted by hand belong to the previous file.
      holeEdits: NO_HOLE_EDITS,
      selectedHoles: NO_SELECTION,
      // Every load (even of the same file) fits the sheet to the whole song on a single strip, with
      // the paper border drawn.
      musicBoxSvgFormatOptions: fitFormatToSong(
        midiFile, state.musicBoxProfile, { ...state.musicBoxSvgFormatOptions, renderBorder: true }, "auto"),
    }));
  }

  /**
   * The notes of the loaded MP3 were detected again with other settings: other notes, other length.
   * The holes deleted by hand were notes of the previous detection, so they are dropped.
   */
  private onMidiDataReconverted(midiFile: MidiFile) {
    this.player.stop();
    this.setState((state) => ({
      midiFile,
      midiJson: MidiJsonConverter.GetJson(midiFile),
      holeEdits: NO_HOLE_EDITS,
      selectedHoles: NO_SELECTION,
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
    await this.player.play(this.buildPianoSequence());
  }

  /** The notes punched in the strip (without the holes deleted by hand), for the piano. */
  private buildPianoSequence(): IGeneratedMusicBoxEvent[] {
    if (!this.state.midiFile) {
      return [];
    }
    return buildGeneratedMusicBoxSequence(
      this.state.midiFile,
      this.state.musicBoxProfile,
      {
        transposeOutOfRangeNotes:
          this.state.musicBoxSvgFormatOptions.transposeOutOfRangeNotes,
        includePercussion: this.state.musicBoxSvgFormatOptions.includePercussion,
        trackSelection: this.state.trackSelection,
        deletedNoteIds: this.state.holeEdits.deleted,
      }
    );
  }

  private toggleDebugMessage(): void {
    this.setState((state) => ({ showMidiJson: !state.showMidiJson }));
  }
}

type LayoutInputs = [MidiFile, IMusicBoxProfile, IMusicBoxSvgFormatOptions, TrackSelection, ReadonlySet<string>];

/**
 * Sizes that fit the whole song (without the holes deleted by hand) on one strip. Without a song,
 * or if it can't be laid out (e.g. it has no playable notes), the options are kept and the preview
 * shows the error.
 */
function fitFormatToSong(
  midiFile: MidiFile | undefined,
  profile: IMusicBoxProfile,
  format: IMusicBoxSvgFormatOptions,
  trackSelection: TrackSelection,
  deletedNoteIds?: ReadonlySet<string>
): IMusicBoxSvgFormatOptions {
  return tryFitFormatToSong(midiFile, profile, format, trackSelection, deletedNoteIds) || format;
}

function tryFitFormatToSong(
  midiFile: MidiFile | undefined,
  profile: IMusicBoxProfile,
  format: IMusicBoxSvgFormatOptions,
  trackSelection: TrackSelection,
  deletedNoteIds?: ReadonlySet<string>
): IMusicBoxSvgFormatOptions | null {
  if (!midiFile) {
    return null;
  }
  try {
    return fitSingleStrip(midiFile, profile, format, trackSelection, deletedNoteIds);
  } catch {
    return null;
  }
}

/**
 * Sheet sizes after deleting or restoring holes (decision of the user): a sheet fitted to the song
 * (its sizes are exactly the fitted ones) is fitted again; sizes typed by hand are kept.
 */
function refitAfterHoleEdits(state: IAppState, deletedNoteIds: ReadonlySet<string>): IMusicBoxSvgFormatOptions {
  const { midiFile, musicBoxProfile, musicBoxSvgFormatOptions: format, trackSelection } = state;
  const fitted = tryFitFormatToSong(midiFile, musicBoxProfile, format, trackSelection, state.holeEdits.deleted);
  const wasFitted = !!fitted && fitted.pageWidthMm === format.pageWidthMm && fitted.pageHeightMm === format.pageHeightMm;
  return wasFitted ? fitFormatToSong(midiFile, musicBoxProfile, format, trackSelection, deletedNoteIds) : format;
}

/** Whether keys pressed on this element edit text (so the editor's shortcuts must not act). */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
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
