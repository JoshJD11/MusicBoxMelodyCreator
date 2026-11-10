import "./DxfPreview.css";

import * as React from "react";
import { Callout, Intent } from "@blueprintjs/core";
import { ICircle, ILine, IMusicBoxLayout } from "../utilities/MusicBoxLayout";
import { IDxfDrawing, parseDxf } from "../utilities/DxfReader";
import { IMusicBoxNote } from "../utilities/MusicBoxNotes";
import { playheadAt, timeAtPoint } from "../utilities/Playhead";

/** The strips to cut: the layout and the DXF document of every sheet (what gets downloaded). */
export interface IStripFiles {
  layout?: IMusicBoxLayout;
  dxfs?: string[];
  error?: string;
}

export interface IDxfPreviewProps {
  files: IStripFiles;
  paperWidthMm: number;
  /**
   * Limits the height of the preview, which then scrolls on its own (long vertical strips would
   * otherwise make the page very long).
   */
  limitHeight?: boolean;
  /** Holes shown as selected (note ids, see `IMusicBoxNote.id`). */
  selectedHoleIds?: ReadonlySet<string>;
  /** Makes the holes selectable: called with the note id of the hole clicked or tapped. */
  onHoleClick?(noteId: string): void;
  /** Shown above the sheets, and below the error when they can't be drawn. */
  toolbar?: React.ReactNode;
  /** The playback line (drawn over the sheets, never part of the DXF). */
  playhead?: IPreviewPlayhead;
}

/** The playback line of the preview: where the song is, on the strips (see utilities/Playhead.ts). */
export interface IPreviewPlayhead {
  /** Song time of the line while it doesn't move by itself (stopped or paused). */
  seconds: number;
  /** While playing, the line follows `getSeconds()` on every frame and the preview scrolls with it. */
  playing: boolean;
  getSeconds(): number | null;
  /** The line is being dragged (it was pressed and moved a few pixels). */
  onDragStart(): void;
  /** The line was dragged to `seconds`, over the holes of these notes (in that order). */
  onDrag(seconds: number, crossed: IMusicBoxNote[]): void;
  onDragEnd(): void;
}

const STROKE_WIDTH_MM = 0.25;

/**
 * How far from the edge of a hole a click still selects it, in mm (holes are only 2-2.2 mm wide).
 * When several holes are that close, the nearest one is picked.
 */
export const HOLE_HIT_MARGIN_MM = 1.2;

/** The same for a finger on a touch screen, less precise than a mouse. */
export const HOLE_TOUCH_MARGIN_MM = 2.5;

/** Gap between a hole and the ring drawn around it when it is hovered or selected, in mm. */
const HOLE_RING_GAP_MM = 0.7;

/** The playback line goes this far beyond each edge of its strip, to a round handle (mm). */
export const PLAYHEAD_OVERHANG_MM = 2.5;
const PLAYHEAD_KNOB_RADIUS_MM = 1.4;

/** A press on the line becomes a drag after moving this much (px); less is a click (on a hole). */
const DRAG_THRESHOLD_PX = { mouse: 4, touch: 8 };

/** At most this many holes sound per movement of the line (a fast drag would make a burst). */
export const MAX_SCRUB_NOTES = 6;

/** While playing, the line is kept this far into the preview, along the song direction. */
const FOLLOW_FRACTION = 1 / 3;

/** Dragging the line near the edge of the preview (or of the window) scrolls it (px). */
const EDGE_SCROLL_ZONE_PX = 32;
const EDGE_SCROLL_MAX_PX = 18;

/** How long a hole glows when the line crosses it (ms; the animation is in the CSS). */
const FLASH_MS = 600;

const SVG_NS = "http://www.w3.org/2000/svg";

/** A hole of the strips, with the moment its note sounds. */
interface ITimelineHole {
  seconds: number;
  sheetIndex: number;
  circle: ICircle;
  note: IMusicBoxNote;
}

interface IPlayheadDrag {
  pointerId: number;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  touch: boolean;
  dragging: boolean;
  /** Song time of the line. */
  seconds: number;
}

/**
 * Preview of the strips, drawn from the DXF documents themselves: what is shown is exactly the
 * content of the files that are downloaded. The only additions are the highlights of the holes
 * under the pointer or selected, which are not part of the sheet.
 */
export default class DxfPreview extends React.Component<IDxfPreviewProps> {
  private cachedDxfs?: string[];
  private cachedDrawings: Array<IDxfDrawing | Error> = [];
  private cachedLayout?: IMusicBoxLayout;
  private cachedHoleIds: string[][] = [];
  private cachedTimeline?: { layout: IMusicBoxLayout; drawings: Array<IDxfDrawing | Error>; holes: ITimelineHole[] };

  private readonly pagesRef = React.createRef<HTMLDivElement>();
  /** The playback line of every sheet (shown on the sheet where the song is). */
  private playheadGroups: Array<SVGGElement | null> = [];
  private followFrame: number | null = null;
  private edgeFrame: number | null = null;
  private drag: IPlayheadDrag | null = null;
  /** Song time where the line is drawn; null when it isn't. */
  private shownSeconds: number | null = null;
  /** Song time of the previous frame while playing (the holes crossed since then glow). */
  private lastFrameSeconds: number | null = null;
  /** The click that ends a drag must not select a hole. */
  private suppressClick = false;
  private flashTimers = new Set<number>();

  public render() {
    const { layout, dxfs, error } = this.props.files;

    if (error || !layout || !dxfs) {
      return (
        <>
          <Callout intent={Intent.DANGER}>
            <p>Error encountered</p>
            <p>{error}</p>
          </Callout>
          {this.props.toolbar}
        </>
      );
    }

    const hasWarnings = layout.messages.some((m) => m.level === "warning");
    const drawings = this.getDrawings(dxfs);
    const holeIds = this.getHoleIds(layout);

    return (
      <>
        <Callout intent={hasWarnings ? Intent.WARNING : Intent.SUCCESS}>
          {layout.messages.map((message, i) => (
            <p key={i}>{message.text}</p>
          ))}
          <p>
            Total paper length: {layout.totalPaperLengthMm.toFixed(2)} mm,
            width: {this.props.paperWidthMm} mm
          </p>
        </Callout>
        {this.props.toolbar}
        <div
          ref={this.pagesRef}
          className={
            "mb-musicBoxSvgPages" +
            (this.props.limitHeight ? " mb-musicBoxSvgPages-limited" : "") +
            // While the line moves by itself the box scrolls with it: the user's scrolling (wheel,
            // finger) goes to the page instead of fighting it.
            (this.props.playhead && this.props.playhead.playing ? " mb-musicBoxSvgPages-following" : "")
          }
          onClickCapture={this.onClickCapture}
        >
          {drawings.map((drawing, index) => (
            <div className="mb-musicBoxSvgWrapper" key={index}>
              {drawing instanceof Error ? (
                <Callout intent={Intent.DANGER}>
                  Sheet {index + 1}: {drawing.message}
                </Callout>
              ) : (
                <DxfDrawingSvg
                  drawing={drawing}
                  holeIds={holeIds[index]}
                  selectedHoleIds={this.props.selectedHoleIds}
                  onHoleClick={this.props.onHoleClick}
                  overlay={this.props.playhead ? this.renderPlayhead(index) : undefined}
                />
              )}
            </div>
          ))}
        </div>
      </>
    );
  }

  /** Parsing is only repeated when the DXF documents change. */
  private getDrawings(dxfs: string[]): Array<IDxfDrawing | Error> {
    if (this.cachedDxfs !== dxfs) {
      this.cachedDxfs = dxfs;
      this.cachedDrawings = dxfs.map((dxf) => {
        try {
          return parseDxf(dxf);
        } catch (error) {
          return error instanceof Error ? error : new Error(String(error));
        }
      });
    }
    return this.cachedDrawings;
  }

  /** For every sheet, the note id of each hole (in the order of its circles). */
  private getHoleIds(layout: IMusicBoxLayout): string[][] {
    if (this.cachedLayout !== layout) {
      this.cachedLayout = layout;
      this.cachedHoleIds = (layout.holeNotes || []).map((notes) => notes.map((note) => note.id));
    }
    return this.cachedHoleIds;
  }

  public componentDidMount() {
    this.syncPlayhead();
  }

  public componentDidUpdate() {
    this.syncPlayhead();
  }

  public componentWillUnmount() {
    this.stopFollowing();
    this.stopEdgeScroll();
    this.flashTimers.forEach((timer) => window.clearTimeout(timer));
    this.flashTimers.clear();
  }

  /** The line of one sheet: placed (and shown or hidden) by `showPlayhead`, outside React. */
  private renderPlayhead(index: number) {
    return (
      <g
        className="mb-playhead"
        style={{ display: "none" }}
        ref={(group) => { this.playheadGroups[index] = group; }}
      >
        <g className="mb-playheadFlashes" />
        <line className="mb-playheadLine" />
        <circle className="mb-playheadKnob" r={PLAYHEAD_KNOB_RADIUS_MM} />
        <circle className="mb-playheadKnob" r={PLAYHEAD_KNOB_RADIUS_MM} />
        <line
          className="mb-playheadHit"
          ref={this.attachTouchGuard}
          onPointerDown={this.onPlayheadPointerDown}
          onPointerMove={this.onPlayheadPointerMove}
          onPointerUp={this.onPlayheadPointerUp}
          onPointerCancel={this.onPlayheadPointerUp}
        >
          <title>Drag to move the playback position</title>
        </line>
      </g>
    );
  }

  /** The playable layout, if the line can be drawn. */
  private playableLayout(): IMusicBoxLayout | null {
    const { layout, dxfs, error } = this.props.files;
    return this.props.playhead && layout && dxfs && !error && layout.pages && layout.pages.length > 0 ? layout : null;
  }

  /** After every render: the line follows the song while playing, else it is where the props say. */
  private syncPlayhead() {
    const playhead = this.props.playhead;
    if (!playhead || !this.playableLayout()) {
      this.stopFollowing();
      return;
    }
    if (this.drag && this.drag.dragging) {
      // (React may have replaced the class list of the box.)
      if (this.pagesRef.current) {
        this.pagesRef.current.classList.add("mb-playheadDragging");
      }
      this.showPlayhead(this.drag.seconds);
      return;
    }
    if (playhead.playing) {
      if (this.followFrame === null) {
        this.lastFrameSeconds = null;
        this.onFollowFrame();
      }
    } else {
      this.stopFollowing();
      this.showPlayhead(playhead.seconds);
    }
  }

  private readonly onFollowFrame = () => {
    this.followFrame = null;
    const playhead = this.props.playhead;
    if (!playhead || !playhead.playing || (this.drag && this.drag.dragging) || !this.playableLayout()) {
      return;
    }
    const seconds = playhead.getSeconds();
    if (seconds !== null) {
      this.flashCrossed(this.lastFrameSeconds, seconds);
      this.lastFrameSeconds = seconds;
      const line = this.showPlayhead(seconds);
      if (line) {
        this.follow(line);
      }
    }
    this.followFrame = window.requestAnimationFrame(this.onFollowFrame);
  };

  private stopFollowing() {
    if (this.followFrame !== null) {
      window.cancelAnimationFrame(this.followFrame);
      this.followFrame = null;
    }
  }

  /**
   * Draws the line of the moment `seconds` on its sheet (hidden on the others). Returns the visible
   * line element.
   */
  private showPlayhead(seconds: number): SVGLineElement | null {
    const layout = this.playableLayout();
    const position = layout ? playheadAt(layout, seconds) : null;
    let shown: SVGLineElement | null = null;
    this.playheadGroups.forEach((group, index) => {
      if (!group) {
        return;
      }
      const visible = !!position && position.sheetIndex === index;
      group.style.display = visible ? "" : "none";
      if (visible && position) {
        placePlayhead(group, position.line);
        shown = group.querySelector(".mb-playheadLine");
      }
    });
    this.shownSeconds = position ? position.seconds : null;
    return shown;
  }

  /**
   * Keeps the line in view while playing, like the paper moving under the comb: only the box of the
   * strips scrolls (decision of the user), so that the line stays at a third of it along the song
   * direction. The page itself never scrolls by itself.
   */
  private follow(line: SVGLineElement) {
    const box = this.pagesRef.current;
    if (!box) {
      return;
    }
    const vertical = this.playableLayout()!.stripOrientation === "vertical";
    const lineRect = line.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    const lineX = (lineRect.left + lineRect.right) / 2;
    const lineY = (lineRect.top + lineRect.bottom) / 2;
    if (vertical) {
      box.scrollTop += lineY - (boxRect.top + boxRect.height * FOLLOW_FRACTION);
      if (lineRect.left < boxRect.left || lineRect.right > boxRect.right) {
        box.scrollLeft += lineX - (boxRect.left + boxRect.width / 2);
      }
    } else {
      box.scrollLeft += lineX - (boxRect.left + boxRect.width * FOLLOW_FRACTION);
      if (lineRect.top < boxRect.top || lineRect.bottom > boxRect.bottom) {
        box.scrollTop += lineY - (boxRect.top + boxRect.height / 2);
      }
    }
  }

  /** Every hole with the moment its note sounds, sorted by time (for the glow and the scrubbing). */
  private getTimeline(layout: IMusicBoxLayout): ITimelineHole[] {
    const drawings = this.cachedDrawings;
    const cached = this.cachedTimeline;
    if (cached && cached.layout === layout && cached.drawings === drawings) {
      return cached.holes;
    }
    const holes: ITimelineHole[] = [];
    (layout.holeNotes || []).forEach((notes, sheetIndex) => {
      const drawing = drawings[sheetIndex];
      if (!drawing || drawing instanceof Error || drawing.circles.length !== notes.length) {
        return;
      }
      notes.forEach((note, j) => holes.push({ seconds: note.timeSeconds, sheetIndex, circle: drawing.circles[j], note }));
    });
    holes.sort((a, b) => a.seconds - b.seconds);
    this.cachedTimeline = { layout, drawings, holes };
    return holes;
  }

  /**
   * Holes crossed when the line goes from `from` to `to`: (from, to] forwards, [to, from)
   * backwards, in the order the line meets them.
   */
  private holesBetween(from: number, to: number): ITimelineHole[] {
    const layout = this.playableLayout();
    if (!layout || from === to) {
      return [];
    }
    const holes = this.getTimeline(layout);
    // Runs on every frame while playing: binary searches instead of going through every hole.
    const firstAfter = (seconds: number) => firstIndex(holes, (hole) => hole.seconds > seconds);
    const firstFrom = (seconds: number) => firstIndex(holes, (hole) => hole.seconds >= seconds);
    if (to > from) {
      return holes.slice(firstAfter(from), firstAfter(to));
    }
    return holes.slice(firstFrom(to), firstFrom(from)).reverse();
  }

  /** While playing: the holes crossed since the previous frame glow (not after a jump). */
  private flashCrossed(from: number | null, to: number) {
    if (from === null || to <= from || to - from > 0.5) {
      return;
    }
    this.holesBetween(from, to).forEach((hole) => this.flash(hole));
  }

  private flash(hole: ITimelineHole) {
    const group = this.playheadGroups[hole.sheetIndex];
    const layer = group && group.querySelector(".mb-playheadFlashes");
    if (!layer) {
      return;
    }
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("class", "mb-playheadFlash");
    circle.setAttribute("cx", String(hole.circle.cx));
    circle.setAttribute("cy", String(hole.circle.cy));
    circle.setAttribute("r", String(hole.circle.r + HOLE_RING_GAP_MM / 2));
    layer.appendChild(circle);
    const timer = window.setTimeout(() => {
      this.flashTimers.delete(timer);
      circle.remove();
    }, FLASH_MS);
    this.flashTimers.add(timer);
  }

  /** The song time of a point of the screen: on the sheet under it (or the nearest one). */
  private secondsAtClient(clientX: number, clientY: number): number | null {
    const layout = this.playableLayout();
    const box = this.pagesRef.current;
    if (!layout || !box) {
      return null;
    }
    const drawings = this.cachedDrawings;
    let best: { distance: number; sheetIndex: number; rect: DOMRect } | null = null;
    Array.from(box.children).forEach((wrapper, sheetIndex) => {
      const svg = wrapper.querySelector("svg");
      const drawing = drawings[sheetIndex];
      if (!svg || !drawing || drawing instanceof Error) {
        return;
      }
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      const dx = Math.max(rect.left - clientX, 0, clientX - rect.right);
      const dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom);
      const distance = Math.hypot(dx, dy);
      if (!best || distance < best.distance) {
        best = { distance, sheetIndex, rect };
      }
    });
    if (!best) {
      return null;
    }
    const { sheetIndex, rect } = best as { distance: number; sheetIndex: number; rect: DOMRect };
    const drawing = drawings[sheetIndex] as IDxfDrawing;
    return timeAtPoint(
      layout,
      sheetIndex,
      ((clientX - rect.left) * drawing.widthMm) / rect.width,
      ((clientY - rect.top) * drawing.heightMm) / rect.height
    );
  }

  private readonly onPlayheadPointerDown = (event: React.PointerEvent<SVGLineElement>) => {
    if (event.button > 0 || !this.props.playhead || this.shownSeconds === null) {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Not supported (or the pointer is gone): the drag still works while over the line.
    }
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      touch: event.pointerType === "touch",
      dragging: false,
      seconds: this.shownSeconds,
    };
  };

  private readonly onPlayheadPointerMove = (event: React.PointerEvent<SVGLineElement>) => {
    const drag = this.drag;
    const playhead = this.props.playhead;
    if (!drag || drag.pointerId !== event.pointerId || !playhead) {
      return;
    }
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    if (!drag.dragging) {
      const threshold = drag.touch ? DRAG_THRESHOLD_PX.touch : DRAG_THRESHOLD_PX.mouse;
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < threshold) {
        return; // Still a click (on a hole under the line, maybe).
      }
      drag.dragging = true;
      this.stopFollowing();
      if (this.pagesRef.current) {
        this.pagesRef.current.classList.add("mb-playheadDragging");
      }
      playhead.onDragStart();
      this.edgeFrame = window.requestAnimationFrame(this.onEdgeFrame);
    }
    // No hover ring on the holes while dragging.
    event.stopPropagation();
    this.dragTo(event.clientX, event.clientY);
  };

  private readonly onPlayheadPointerUp = (event: React.PointerEvent<SVGLineElement>) => {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    this.drag = null;
    this.stopEdgeScroll();
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    if (drag.dragging) {
      if (this.pagesRef.current) {
        this.pagesRef.current.classList.remove("mb-playheadDragging");
      }
      // The click that follows the drag (if any) must not select the hole under the line.
      this.suppressClick = true;
      window.setTimeout(() => { this.suppressClick = false; }, 0);
      if (this.props.playhead) {
        this.props.playhead.onDragEnd();
      }
    }
  };

  private readonly onClickCapture = (event: React.MouseEvent) => {
    if (this.suppressClick) {
      this.suppressClick = false;
      event.stopPropagation();
    }
  };

  /** Moves the dragged line to the point of the screen, playing the holes it crosses. */
  private dragTo(clientX: number, clientY: number) {
    const drag = this.drag;
    const layout = this.playableLayout();
    const playhead = this.props.playhead;
    if (!drag || !layout || !playhead) {
      return;
    }
    const target = this.secondsAtClient(clientX, clientY);
    const position = target === null ? null : playheadAt(layout, target);
    if (!position || position.seconds === drag.seconds) {
      return;
    }
    const crossed = this.holesBetween(drag.seconds, position.seconds).slice(-MAX_SCRUB_NOTES);
    drag.seconds = position.seconds;
    this.showPlayhead(position.seconds);
    crossed.forEach((hole) => this.flash(hole));
    playhead.onDrag(position.seconds, crossed.map((hole) => hole.note));
  }

  /** While dragging near the edge of the preview (or of the window), it scrolls. */
  private readonly onEdgeFrame = () => {
    this.edgeFrame = null;
    const drag = this.drag;
    const box = this.pagesRef.current;
    if (!drag || !drag.dragging || !box) {
      return;
    }
    const speed = (distance: number) => Math.min(EDGE_SCROLL_MAX_PX, 2 + distance / 2);
    const rect = box.getBoundingClientRect();
    const zone = EDGE_SCROLL_ZONE_PX;
    const { clientX: x, clientY: y } = drag;
    const before = [box.scrollLeft, box.scrollTop, window.scrollX, window.scrollY];
    if (box.scrollHeight > box.clientHeight) {
      if (y < rect.top + zone) {
        box.scrollTop -= speed(rect.top + zone - y);
      } else if (y > rect.bottom - zone) {
        box.scrollTop += speed(y - (rect.bottom - zone));
      }
    }
    if (box.scrollWidth > box.clientWidth) {
      if (x < rect.left + zone) {
        box.scrollLeft -= speed(rect.left + zone - x);
      } else if (x > rect.right - zone) {
        box.scrollLeft += speed(x - (rect.right - zone));
      }
    }
    if (y < zone) {
      window.scrollBy(0, -speed(zone - y));
    } else if (y > window.innerHeight - zone) {
      window.scrollBy(0, speed(y - (window.innerHeight - zone)));
    }
    const after = [box.scrollLeft, box.scrollTop, window.scrollX, window.scrollY];
    if (after.some((value, i) => value !== before[i])) {
      this.dragTo(x, y);
    }
    this.edgeFrame = window.requestAnimationFrame(this.onEdgeFrame);
  };

  private stopEdgeScroll() {
    if (this.edgeFrame !== null) {
      window.cancelAnimationFrame(this.edgeFrame);
      this.edgeFrame = null;
    }
  }

  /**
   * Some browsers ignore `touch-action` on SVG shapes: while the line is pressed, a finger moving
   * on it must drag the line, not scroll the page. Only the movement is prevented, so a tap still
   * selects the hole under the line.
   */
  private readonly attachTouchGuard = (line: SVGLineElement | null) => {
    if (line && !line.dataset.touchGuard) {
      line.dataset.touchGuard = "1";
      line.addEventListener("touchmove", (event) => {
        if (this.drag) {
          event.preventDefault();
        }
      }, { passive: false });
    }
  };
}

/** Index of the first item for which `test` is true, in a list where it is false and then true. */
function firstIndex<T>(items: T[], test: (item: T) => boolean): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (test(items[middle])) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

/** Places the line (and its handles, beyond the edges of the strip) of one sheet. */
function placePlayhead(group: SVGGElement, line: ILine) {
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const length = Math.hypot(dx, dy) || 1;
  const ox = (dx / length) * PLAYHEAD_OVERHANG_MM;
  const oy = (dy / length) * PLAYHEAD_OVERHANG_MM;
  const ends = [line.x1 - ox, line.y1 - oy, line.x2 + ox, line.y2 + oy].map(String);
  group.querySelectorAll(".mb-playheadLine, .mb-playheadHit").forEach((element) => {
    element.setAttribute("x1", ends[0]);
    element.setAttribute("y1", ends[1]);
    element.setAttribute("x2", ends[2]);
    element.setAttribute("y2", ends[3]);
  });
  const knobs = group.querySelectorAll(".mb-playheadKnob");
  if (knobs.length === 2) {
    knobs[0].setAttribute("cx", ends[0]);
    knobs[0].setAttribute("cy", ends[1]);
    knobs[1].setAttribute("cx", ends[2]);
    knobs[1].setAttribute("cy", ends[3]);
  }
}

/**
 * Index of the hole nearest to the point (x, y) (sheet mm), among those whose edge is at most
 * `marginMm` away; null if there is none.
 */
export function findHoleAt(circles: ICircle[], x: number, y: number, marginMm = HOLE_HIT_MARGIN_MM): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  circles.forEach((circle, i) => {
    const distance = Math.hypot(circle.cx - x, circle.cy - y);
    if (distance <= circle.r + marginMm && distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}

export interface IDxfDrawingSvgProps {
  drawing: IDxfDrawing;
  /** Note id of every circle of the drawing, in order. */
  holeIds?: string[];
  selectedHoleIds?: ReadonlySet<string>;
  /**
   * Makes the holes selectable (only if `holeIds` has one id per circle): a hole is ringed when
   * the mouse is over it, and a click or tap reports its note id.
   */
  onHoleClick?(noteId: string): void;
  /** Drawn over the sheet, in its millimeters (the playback line). */
  overlay?: React.ReactNode;
}

/** Draws one DXF sheet, in millimeters. */
export function DxfDrawingSvg(props: IDxfDrawingSvgProps) {
  const { drawing, holeIds, selectedHoleIds, onHoleClick, overlay } = props;
  const w = drawing.widthMm;
  const h = drawing.heightMm;
  const svgRef = React.useRef<SVGSVGElement>(null);
  // Whether the last press was a finger: its click gets a wider margin.
  const touchPress = React.useRef(false);
  // An id rather than an index: once that hole is deleted, nothing stays ringed.
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);

  const editable = !!onHoleClick && !!holeIds && holeIds.length === drawing.circles.length;

  const holeAt = (clientX: number, clientY: number, marginMm = HOLE_HIT_MARGIN_MM): string | null => {
    const svg = svgRef.current;
    if (!svg || !holeIds) {
      return null;
    }
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const index = findHoleAt(
      drawing.circles,
      ((clientX - rect.left) * w) / rect.width,
      ((clientY - rect.top) * h) / rect.height,
      marginMm
    );
    return index === null ? null : holeIds[index];
  };

  const handlers: React.SVGProps<SVGSVGElement> = editable
    ? {
      onPointerMove: (event) => {
        // Touch screens have no hover: a tap selects directly.
        if (event.pointerType !== "touch") {
          setHoveredId(holeAt(event.clientX, event.clientY));
        }
      },
      onPointerLeave: () => setHoveredId(null),
      onPointerDown: (event) => {
        touchPress.current = event.pointerType === "touch";
      },
      onClick: (event) => {
        const id = holeAt(event.clientX, event.clientY, touchPress.current ? HOLE_TOUCH_MARGIN_MM : HOLE_HIT_MARGIN_MM);
        if (id !== null && onHoleClick) {
          onHoleClick(id);
        }
      },
    }
    : {};

  const hoveredIndex = editable && hoveredId !== null ? holeIds!.indexOf(hoveredId) : -1;

  return (
    <svg
      ref={svgRef}
      width={w + "mm"}
      height={h + "mm"}
      viewBox={`0 0 ${w} ${h}`}
      xmlns={"http://www.w3.org/2000/svg"}
      className={editable ? "mb-sheetSvg mb-sheetSvg-editable" : "mb-sheetSvg"}
      style={hoveredIndex >= 0 ? { cursor: "pointer" } : undefined}
      {...handlers}
    >
      <DxfShapes drawing={drawing} />
      {editable && (
        <HoleHighlights
          circles={drawing.circles}
          holeIds={holeIds!}
          selectedHoleIds={selectedHoleIds}
          hoveredIndex={hoveredIndex}
        />
      )}
      {overlay}
    </svg>
  );
}

/** The lines and holes of the DXF. Not redrawn when only the highlights change. */
const DxfShapes = React.memo(function DxfShapes(props: { drawing: IDxfDrawing }) {
  const { drawing } = props;
  return (
    <>
      <g>
        {drawing.lines.map((line, i) => (
          <line
            key={i}
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            stroke="black"
            strokeWidth={STROKE_WIDTH_MM}
          />
        ))}
      </g>
      <g>
        {drawing.circles.map((circle, i) => (
          <circle
            key={i}
            cx={circle.cx}
            cy={circle.cy}
            r={circle.r}
            fill={"none"}
            stroke={"black"}
            strokeWidth={STROKE_WIDTH_MM}
          />
        ))}
      </g>
    </>
  );
});

/** Selected holes are filled and ringed in green; the hole under the mouse is ringed. */
function HoleHighlights(props: {
  circles: ICircle[];
  holeIds: string[];
  selectedHoleIds?: ReadonlySet<string>;
  hoveredIndex: number;
}) {
  const { circles, holeIds, selectedHoleIds, hoveredIndex } = props;
  const selected = selectedHoleIds && selectedHoleIds.size > 0
    ? circles.filter((_, i) => selectedHoleIds.has(holeIds[i]))
    : [];
  const hovered = hoveredIndex >= 0 ? circles[hoveredIndex] : null;
  return (
    <g className="mb-holeHighlights" aria-hidden="true">
      {selected.map((circle, i) => (
        <g key={i} className="mb-hole-selected">
          <circle cx={circle.cx} cy={circle.cy} r={circle.r} className="mb-hole-selectedFill" />
          <circle cx={circle.cx} cy={circle.cy} r={circle.r + HOLE_RING_GAP_MM} className="mb-hole-ring" />
        </g>
      ))}
      {hovered && (
        <circle cx={hovered.cx} cy={hovered.cy} r={hovered.r + HOLE_RING_GAP_MM} className="mb-hole-hover" />
      )}
    </g>
  );
}
