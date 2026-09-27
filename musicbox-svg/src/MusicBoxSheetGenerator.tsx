import React from "react";
import "./MusicBoxSheetGenerator.css";
import MidiFilePicker from "./components/MidiFilePicker";
import MidiFile from "./model/MidiFile";
import MidiJsonConverter from "./utilities/MidiJsonConverter";
import MusicBoxSvg from "./components/MusicBoxSvg";
import { IMusicBoxSvgFormatOptions } from "./model/IMusicBoxSvgFormatOptions";
import { BuiltInProfiles, IMusicBoxProfile } from "./model/IMusicBoxProfile";
import { MusicBoxProfileEditor } from "./components/MusicBoxProfileEditor";
import {
  buildGeneratedMusicBoxSequence,
  IGeneratedMusicBoxEvent,
} from "./utilities/MusicBoxMidi";

import {
  Card,
  Collapse,
  Pre,
  Button,
  NonIdealState,
  ButtonGroup,
} from "@blueprintjs/core";
import { MusicBoxSvgFormatEditor } from "./components/MusicBoxSvgFormatEditor";
import { Tab, Tabs } from "@blueprintjs/core";
import FischerPrice3DModel from "./components/FischerPrice3DModel";

const CREDITS = [
  {
    asset: "Midi Icon",
    by: "Midi Synthesizer by Iconic from the Noun Project",
  },
];

const PLAYBACK_LOOKAHEAD_SECONDS = 0.5;
const PLAYBACK_SCHEDULE_INTERVAL_MS = 100;

interface IAppState {
  midiJson: string;
  fileName?: string;
  midiFile?: MidiFile;
  midiDataAvailable: boolean;
  musicBoxProfile: IMusicBoxProfile;
  musicBoxSvgFormatOptions: IMusicBoxSvgFormatOptions;
  showMidiJson: boolean;
  playbackState: "stopped" | "playing" | "paused";
}

export default class MusicBoxSheetGenerator extends React.Component<
  {},
  IAppState
> {
  private musicBoxSvgRef: MusicBoxSvg | null;
  private audioContext: AudioContext | null;
  private playbackSources: AudioScheduledSourceNode[];
  private playbackTimer: number | null;
  private playbackScheduleTimer: number | null;
  private pendingPlaybackEvents: IGeneratedMusicBoxEvent[];
  private pendingPlaybackIndex: number;
  private playbackStartTime: number;
  private playbackMasterGain: GainNode | null;
  private playbackNoiseBuffer: AudioBuffer | null;
  private playbackEndTime: number;

  constructor(props: {}) {
    super(props);

    this.state = {
      midiJson: "",
      midiDataAvailable: false,
      musicBoxProfile: BuiltInProfiles["thirtyNote"],
      musicBoxSvgFormatOptions: {
        pageWidthMm: 250,
        pageHeightMm: 200,
        startPaddingMm: 10,
        renderBorder: true,
        omitPageBoundaries: false,
        transposeOutOfRangeNotes: true,
        jigsawJoiners: false,
        loopMode: false,
      },
      showMidiJson: false,
      playbackState: "stopped",
    };

    this.musicBoxSvgRef = null;
    this.audioContext = null;
    this.playbackSources = [];
    this.playbackTimer = null;
    this.playbackScheduleTimer = null;
    this.pendingPlaybackEvents = [];
    this.pendingPlaybackIndex = 0;
    this.playbackStartTime = 0;
    this.playbackMasterGain = null;
    this.playbackNoiseBuffer = null;
    this.playbackEndTime = 0;
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

    let filePicker: JSX.Element = (
      <div className="mb-settingsTab-container">
        <MidiFilePicker
          fileName={this.state.fileName}
          midiFile={this.state.midiFile}
          onFileLoaded={(filename, midiFile) =>
            this.onMidiDataLoaded(filename, midiFile)
          }
        />
      </div>
    );

    let paperSettings: JSX.Element = (
      <div className="mb-settingsTab-container">
        <MusicBoxProfileEditor
          profile={this.state.musicBoxProfile}
          onChange={(profile) =>
            this.setState({ ...this.state, musicBoxProfile: profile })
          }
        />
      </div>
    );

    let formatSettings = (
      <div className="mb-settingsTab-container">
        <MusicBoxSvgFormatEditor
          options={this.state.musicBoxSvgFormatOptions}
          onChange={(options) =>
            this.setState({ ...this.state, musicBoxSvgFormatOptions: options })
          }
        />
      </div>
    );

    let fischerPriceSettings: JSX.Element;
    if (!this.state.midiDataAvailable || !this.state.midiFile) {
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
        <FischerPrice3DModel
          midiFile={this.state.midiFile!}
          musicBoxProfile={this.state.musicBoxProfile}
        />
      );
    }

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
            <span className={this.state.midiDataAvailable ? "mb-statusDot mb-statusDot-ready" : "mb-statusDot"} />
            {this.state.midiDataAvailable ? "MIDI ready" : "No MIDI loaded"}
          </div>
        </header>
        <div className="mb-workspace">
          <aside className="mb-settingsArea">
            <Tabs
              animate={true}
              id="settings-tabs"
              key={"settings-tabs"}
              renderActiveTabPanelOnly={true}
              vertical={true}
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
                title="3D Printable Fischer Price"
                panel={fischerPriceSettings}
              />
              <Tabs.Expander />
            </Tabs>
          </aside>
          {this.state.midiDataAvailable && this.state.midiFile ? (
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
                      icon={this.state.playbackState === "playing" ? "pause" : "play"}
                      text={this.state.playbackState === "playing" ? "Pause piano" : "Play generated piano"}
                      onClick={() => this.toggleGeneratedPiano()}
                    />
                    <Button
                      icon={"refresh"}
                      text={"Restart piano"}
                      onClick={() => this.restartGeneratedPiano()}
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
                  ref={(el) => {
                    this.musicBoxSvgRef = el;
                  }}
                  musicBoxProfile={this.state.musicBoxProfile}
                  formatting={this.state.musicBoxSvgFormatOptions}
                  midiFile={this.state.midiFile}
                  elementId={"mb-musicBoxSvg"}
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
            Code: <a href="https://github.com/SabinT/musicbox-svg">GitHub</a>
            <span className="mb-footerDivider">/</span>Credits: {credits}
          </div>
        </footer>
      </div>
    );
  }

  private onMidiDataLoaded(fileName: string, midiFile: MidiFile) {
    this.setState({
      midiFile: midiFile,
      fileName: fileName,
      midiJson: MidiJsonConverter.GetJson(midiFile),
      midiDataAvailable: true,
    });
  }

  private downloadDxfs() {
    if (this.musicBoxSvgRef) {
      const numPages = this.musicBoxSvgRef.getNumPages();

      for (let i = 0; i < numPages; i++) {
        const svgData = this.musicBoxSvgRef.getSvg(i);
        if (svgData) {
          const svgDocument = new DOMParser().parseFromString(
            svgData,
            "image/svg+xml"
          );
          const svgElement = svgDocument.documentElement;
          const widthMm = parseFloat(svgElement.getAttribute("width") || "0");
          const heightMm = parseFloat(
            svgElement.getAttribute("height") || "0"
          );
          const dxfData = createDxfFromSvg(svgElement, widthMm, heightMm);
          const dxfBlob = new Blob([dxfData], {
            type: "application/dxf",
          });
          const dxfUrl = URL.createObjectURL(dxfBlob);
          const downloadLink = document.createElement("a");
          downloadLink.href = dxfUrl;

          const sourceFileName = this.state.fileName || "musicBox";
          const baseFileName = sourceFileName
            .replace(/\.(midi|mid)$/i, "")
            .replace(/[<>:"/\\|?*]/g, "_");

          downloadLink.download = `${baseFileName}_page_${i + 1}.dxf`;

          document.body.appendChild(downloadLink);
          downloadLink.click();
          document.body.removeChild(downloadLink);
          URL.revokeObjectURL(dxfUrl);
        }
      }
    }
  }

  private copyMidiJson(): void {
    navigator.clipboard.writeText(this.state.midiJson);
  }

  private async toggleGeneratedPiano(): Promise<void> {
    if (this.state.playbackState === "playing") {
      await this.pauseGeneratedPiano();
      return;
    }

    if (this.state.playbackState === "paused") {
      if (this.audioContext) {
        await this.audioContext.resume();
        this.schedulePendingPlaybackEvents();
        this.setState({ ...this.state, playbackState: "playing" });
        this.schedulePlaybackCompletion(
          this.playbackEndTime - this.audioContext.currentTime
        );
      }
      return;
    }

    await this.playGeneratedPiano();
  }

  private async playGeneratedPiano(): Promise<void> {
    if (!this.state.midiFile) {
      return;
    }

    const sequence = buildGeneratedMusicBoxSequence(
      this.state.midiFile,
      this.state.musicBoxProfile,
      this.state.musicBoxSvgFormatOptions.transposeOutOfRangeNotes
    );

    if (!sequence.length) {
      return;
    }

    const AudioCtor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtor) {
      return;
    }

    this.stopPlaybackSources();
    this.audioContext = this.audioContext ?? new AudioCtor();
    const context = this.audioContext;

    if (!context) {
      return;
    }

    if (context.state === "suspended") {
      await context.resume();
    }

    const masterGain = context.createGain();
    masterGain.gain.value = 0.3;
    masterGain.connect(context.destination);

    const now = context.currentTime;
    const playbackDuration = sequence.reduce(
      (duration, event) =>
        Math.max(
          duration,
          event.startTimeSeconds + getPianoReleaseSeconds(event.note) + 0.05
        ),
      0
    );
    this.pendingPlaybackEvents = sequence;
    this.pendingPlaybackIndex = 0;
    this.playbackStartTime = now + PLAYBACK_LOOKAHEAD_SECONDS;
    this.playbackMasterGain = masterGain;
    this.playbackNoiseBuffer = createPianoNoiseBuffer(context);
    this.schedulePendingPlaybackEvents();

    this.setState({ ...this.state, playbackState: "playing" });
    this.playbackEndTime = this.playbackStartTime + playbackDuration;
    this.schedulePlaybackCompletion(
      this.playbackEndTime - context.currentTime
    );
  }

  private schedulePendingPlaybackEvents(): void {
    if (
      !this.audioContext ||
      !this.playbackMasterGain ||
      !this.playbackNoiseBuffer
    ) {
      return;
    }

    const scheduleUntil =
      this.audioContext.currentTime -
      this.playbackStartTime +
      PLAYBACK_LOOKAHEAD_SECONDS;

    while (
      this.pendingPlaybackIndex < this.pendingPlaybackEvents.length &&
      this.pendingPlaybackEvents[this.pendingPlaybackIndex].startTimeSeconds <=
        scheduleUntil
    ) {
      const event = this.pendingPlaybackEvents[this.pendingPlaybackIndex];
      const { sources } = createPianoNote(
        this.audioContext,
        this.playbackMasterGain,
        event.note,
        this.playbackStartTime + event.startTimeSeconds,
        event.velocity,
        this.playbackNoiseBuffer
      );
      this.playbackSources.push(...sources);
      this.pendingPlaybackIndex++;
    }

    if (this.pendingPlaybackIndex < this.pendingPlaybackEvents.length) {
      this.playbackScheduleTimer = window.setTimeout(
        () => this.schedulePendingPlaybackEvents(),
        PLAYBACK_SCHEDULE_INTERVAL_MS
      );
    } else {
      this.playbackScheduleTimer = null;
    }
  }

  private schedulePlaybackCompletion(delaySeconds: number): void {
    this.playbackTimer = window.setTimeout(() => {
      if (this.playbackScheduleTimer !== null) {
        window.clearTimeout(this.playbackScheduleTimer);
        this.playbackScheduleTimer = null;
      }
      this.playbackSources = [];
      this.pendingPlaybackEvents = [];
      this.pendingPlaybackIndex = 0;
      this.playbackTimer = null;
      this.setState({ ...this.state, playbackState: "stopped" });
    }, Math.max(0, delaySeconds * 1000));
  }

  private async pauseGeneratedPiano(): Promise<void> {
    if (this.audioContext) {
      const remainingSeconds = Math.max(
        0,
        this.playbackEndTime - this.audioContext.currentTime
      );
      if (this.playbackTimer !== null) {
        window.clearTimeout(this.playbackTimer);
        this.playbackTimer = null;
      }
      if (this.playbackScheduleTimer !== null) {
        window.clearTimeout(this.playbackScheduleTimer);
        this.playbackScheduleTimer = null;
      }
      this.playbackEndTime = this.audioContext.currentTime + remainingSeconds;
      await this.audioContext.suspend();
      this.setState({ ...this.state, playbackState: "paused" });
    }
  }

  private async restartGeneratedPiano(): Promise<void> {
    this.stopPlaybackSources();
    if (this.audioContext) {
      await this.audioContext.suspend();
    }
    this.setState({ ...this.state, playbackState: "stopped" });
    await this.playGeneratedPiano();
  }

  private stopPlaybackSources(): void {
    if (this.playbackTimer !== null) {
      window.clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    if (this.playbackScheduleTimer !== null) {
      window.clearTimeout(this.playbackScheduleTimer);
      this.playbackScheduleTimer = null;
    }

    this.playbackSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // A source may already have finished naturally.
      }
      source.disconnect();
    });
    this.playbackSources = [];
    this.pendingPlaybackEvents = [];
    this.pendingPlaybackIndex = 0;
    this.playbackMasterGain = null;
    this.playbackNoiseBuffer = null;
  }

  private toggleDebugMessage(): void {
    this.setState({ ...this.state, showMidiJson: !this.state.showMidiJson });
  }
}

interface IDxfTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY_DXF_TRANSFORM: IDxfTransform = {
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
};

function createDxfFromSvg(
  svgElement: Element,
  widthMm: number,
  heightMm: number
): string {
  const entities: string[] = [];

  appendDxfEntities(
    svgElement,
    IDENTITY_DXF_TRANSFORM,
    heightMm,
    entities
  );

  const dxf = [
    "0",
    "SECTION",
    "2",
    "HEADER",
    "9",
    "$ACADVER",
    "1",
    "AC1009",
    "9",
    "$INSUNITS",
    "70",
    "4",
    "9",
    "$EXTMIN",
    "10",
    "0",
    "20",
    "0",
    "9",
    "$EXTMAX",
    "10",
    formatDxfNumber(widthMm),
    "20",
    formatDxfNumber(heightMm),
    "0",
    "ENDSEC",
    "0",
    "SECTION",
    "2",
    "ENTITIES",
    ...entities,
    "0",
    "ENDSEC",
    "0",
    "EOF",
  ];

  return dxf.join("\r\n") + "\r\n";
}

function appendDxfEntities(
  element: Element,
  parentTransform: IDxfTransform,
  heightMm: number,
  entities: string[]
) {
  const transform = multiplyDxfTransforms(
    parentTransform,
    parseDxfTransform(element.getAttribute("transform"))
  );
  const tagName = element.tagName.toLowerCase();

  if (tagName === "line") {
    const start = transformDxfPoint(
      transform,
      parseFloat(element.getAttribute("x1") || "0"),
      parseFloat(element.getAttribute("y1") || "0")
    );
    const end = transformDxfPoint(
      transform,
      parseFloat(element.getAttribute("x2") || "0"),
      parseFloat(element.getAttribute("y2") || "0")
    );
    appendDxfLine(entities, start, end, heightMm);
  } else if (tagName === "circle") {
    const center = transformDxfPoint(
      transform,
      parseFloat(element.getAttribute("cx") || "0"),
      parseFloat(element.getAttribute("cy") || "0")
    );
    const radius =
      parseFloat(element.getAttribute("r") || "0") *
      Math.sqrt(transform.a * transform.a + transform.b * transform.b);
    appendDxfCircle(entities, center, radius, heightMm);
  }

  for (let i = 0; i < element.children.length; i++) {
    appendDxfEntities(element.children[i], transform, heightMm, entities);
  }
}

function appendDxfLine(
  entities: string[],
  start: { x: number; y: number },
  end: { x: number; y: number },
  heightMm: number
) {
  entities.push(
    "0",
    "LINE",
    "8",
    "CUT",
    "10",
    formatDxfNumber(start.x),
    "20",
    formatDxfNumber(heightMm - start.y),
    "30",
    "0",
    "11",
    formatDxfNumber(end.x),
    "21",
    formatDxfNumber(heightMm - end.y),
    "31",
    "0"
  );
}

function appendDxfCircle(
  entities: string[],
  center: { x: number; y: number },
  radius: number,
  heightMm: number
) {
  entities.push(
    "0",
    "CIRCLE",
    "8",
    "HOLES",
    "10",
    formatDxfNumber(center.x),
    "20",
    formatDxfNumber(heightMm - center.y),
    "30",
    "0",
    "40",
    formatDxfNumber(radius)
  );
}

function transformDxfPoint(
  transform: IDxfTransform,
  x: number,
  y: number
): { x: number; y: number } {
  return {
    x: transform.a * x + transform.c * y + transform.e,
    y: transform.b * x + transform.d * y + transform.f,
  };
}

function parseDxfTransform(value: string | null): IDxfTransform {
  if (!value) {
    return IDENTITY_DXF_TRANSFORM;
  }

  let transform = IDENTITY_DXF_TRANSFORM;
  const transformPattern = /(matrix|translate)\s*\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = transformPattern.exec(value)) !== null) {
    const values = match[2].split(/[ ,]+/).map(Number);
    const localTransform: IDxfTransform =
      match[1] === "matrix"
        ? {
            a: values[0],
            b: values[1],
            c: values[2],
            d: values[3],
            e: values[4],
            f: values[5],
          }
        : {
            ...IDENTITY_DXF_TRANSFORM,
            e: values[0],
            f: values[1] || 0,
          };
    transform = multiplyDxfTransforms(transform, localTransform);
  }

  return transform;
}

function multiplyDxfTransforms(
  left: IDxfTransform,
  right: IDxfTransform
): IDxfTransform {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

function formatDxfNumber(value: number): string {
  const rounded = Math.abs(value) < 0.000001 ? 0 : value;
  return rounded.toFixed(6).replace(/\.?(0+)$/, "");
}

function midiToFrequency(midiNumber: number): number {
  return 440 * Math.pow(2, (midiNumber - 69) / 12);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface IPianoNoteResult {
  sources: AudioScheduledSourceNode[];
  releaseSeconds: number;
}

function getPianoReleaseSeconds(midiNote: number): number {
  const baseDecay = clamp(2.6 - (midiNote - 60) * 0.032, 0.5, 4.5);
  return Math.max(0.18, baseDecay) + 0.006;
}

function createPianoNote(
  context: AudioContext,
  destination: AudioNode,
  midiNote: number,
  startTime: number,
  velocity: number,
  noiseBuffer: AudioBuffer
): IPianoNoteResult {
  const fundamental = midiToFrequency(midiNote);
  const velocityGain = 0.18 + 0.6 * (velocity / 127);

  const baseDecay = clamp(2.6 - (midiNote - 60) * 0.032, 0.5, 4.5);

  const partials: Array<{ mult: number; amp: number; decayScale: number }> = [
    { mult: 1, amp: 1.0, decayScale: 1.0 },
    { mult: 2, amp: 0.5, decayScale: 0.72 },
    { mult: 3, amp: 0.26, decayScale: 0.52 },
    { mult: 4.01, amp: 0.16, decayScale: 0.38 },
  ];

  const noteGain = context.createGain();
  noteGain.gain.value = 1;
  noteGain.connect(destination);

  const sources: AudioScheduledSourceNode[] = [];
  let maxRelease = 0;

  partials.forEach((partial) => {
    const osc = context.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(fundamental * partial.mult, startTime);

    const partialGain = context.createGain();
    const attack = partial.mult === 1 ? 0.006 : 0.003;
    const decay = Math.max(0.18, baseDecay * partial.decayScale);
    const peak = velocityGain * partial.amp * 0.45;

    partialGain.gain.setValueAtTime(0.0001, startTime);
    partialGain.gain.exponentialRampToValueAtTime(peak, startTime + attack);
    partialGain.gain.exponentialRampToValueAtTime(
      0.0001,
      startTime + attack + decay
    );

    osc.connect(partialGain);
    partialGain.connect(noteGain);

    osc.start(startTime);
    osc.stop(startTime + attack + decay + 0.05);
    sources.push(osc);

    maxRelease = Math.max(maxRelease, attack + decay);
  });

  // Short bandpass-filtered noise burst approximating the hammer strike.
  const noiseDuration = 0.018;
  const noiseSource = context.createBufferSource();
  noiseSource.buffer = noiseBuffer;

  const noiseFilter = context.createBiquadFilter();
  noiseFilter.type = "bandpass";
  noiseFilter.frequency.setValueAtTime(
    clamp(fundamental * 2.5, 400, 8000),
    startTime
  );
  noiseFilter.Q.value = 0.6;

  const noiseGain = context.createGain();
  noiseGain.gain.setValueAtTime(velocityGain * 0.1, startTime);
  noiseGain.gain.exponentialRampToValueAtTime(
    0.0001,
    startTime + noiseDuration
  );

  noiseSource.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(noteGain);
  noiseSource.start(startTime);
  noiseSource.stop(startTime + noiseDuration + 0.01);
  sources.push(noiseSource);

  return { sources, releaseSeconds: Math.max(maxRelease, noiseDuration) };
}

function createPianoNoiseBuffer(context: AudioContext): AudioBuffer {
  const noiseDuration = 0.018;
  const bufferSize = Math.max(
    1,
    Math.floor(context.sampleRate * noiseDuration)
  );
  const noiseBuffer = context.createBuffer(1, bufferSize, context.sampleRate);
  const channelData = noiseBuffer.getChannelData(0);

  for (let i = 0; i < bufferSize; i++) {
    channelData[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  }

  return noiseBuffer;
}