import React from "react";
import "./MusicBoxSheetGenerator.css";
import MidiFilePicker from "./components/MidiFilePicker";
import MidiFile from "./model/MidiFile";
import MidiJsonConverter from "./utilities/MidiJsonConverter";
import MusicBoxSvg from "./components/MusicBoxSvg";
import { IMusicBoxSvgFormatOptions } from "./model/IMusicBoxSvgFormatOptions";
import { BuiltInProfiles, IMusicBoxProfile } from "./model/IMusicBoxProfile";
import { MusicBoxProfileEditor } from "./components/MusicBoxProfileEditor";
import { buildGeneratedMusicBoxSequence } from "./utilities/MusicBoxMidi";

import {
  Card,
  Collapse,
  Pre,
  Button,
  Divider,
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
  private playbackSources: OscillatorNode[];
  private playbackTimer: number | null;
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
    if (this.state.midiDataAvailable && this.state.midiFile) {
      fischerPriceSettings = (
        <div className="mb-settingsTab-container">
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
        <div className="mb-settingsArea">
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
        </div>
        <Divider />
        {this.state.midiDataAvailable && this.state.midiFile && (
          <div className="mb-musicBox-preview">
            <div className="mb-previewActions">
              <ButtonGroup style={{ minWidth: 200 }}>
                <Button
                  icon={"download"}
                  text={"Download DXF(s)"}
                  onClick={() => {
                    this.downloadDxfs();
                  }}
                />
                <Button
                  icon={
                    this.state.playbackState === "playing" ? "pause" : "play"
                  }
                  text={
                    this.state.playbackState === "playing"
                      ? "Pause piano"
                      : "Play generated piano"
                  }
                  onClick={() => {
                    this.toggleGeneratedPiano();
                  }}
                />
                <Button
                  icon={"refresh"}
                  text={"Restart piano"}
                  onClick={() => {
                    this.restartGeneratedPiano();
                  }}
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
        )}
        <div className="mb-debugMessage-Container">
          {this.state.midiDataAvailable && <Divider />}
          <Card>
            Code is available in{" "}
            <a href="https://github.com/SabinT/musicbox-svg">github</a>
            <br />
            Credits
            <br />
            {credits}
          </Card>
        </div>
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
    masterGain.gain.value = 0.25;
    masterGain.connect(context.destination);

    const now = context.currentTime;
    let playbackDuration = 0;
    for (const event of sequence) {
      const start = now + event.startTimeSeconds;
      const duration = Math.max(0.12, event.durationSeconds);
      playbackDuration = Math.max(
        playbackDuration,
        event.startTimeSeconds + duration + 0.05
      );
      const frequency = midiToFrequency(event.note);

      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const filter = context.createBiquadFilter();

      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(frequency, start);

      filter.type = "lowpass";
      filter.frequency.setValueAtTime(4500, start);
      filter.Q.value = 0.5;

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18 * (event.velocity / 127), start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(masterGain);

      oscillator.start(start);
      oscillator.stop(start + duration + 0.05);
      this.playbackSources.push(oscillator);
    }

    this.setState({ ...this.state, playbackState: "playing" });
    this.playbackEndTime = now + playbackDuration;
    this.schedulePlaybackCompletion(playbackDuration);
  }

  private schedulePlaybackCompletion(delaySeconds: number): void {
    this.playbackTimer = window.setTimeout(() => {
      this.playbackSources = [];
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

    this.playbackSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // An oscillator may already have finished naturally.
      }
      source.disconnect();
    });
    this.playbackSources = [];
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
