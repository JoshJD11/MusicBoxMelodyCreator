import MidiFile from '../model/MidiFile';
import { IMusicBoxProfile } from '../model/IMusicBoxProfile';
import { IMusicBoxSvgFormatOptions } from '../model/IMusicBoxSvgFormatOptions';
import { MidiNote } from '../model/MidiConstants';
import { extractMusicBoxNotes, IMusicBoxNote, INoteExtractionResult, TrackSelection } from './MusicBoxNotes';

/** Length of the jigsaw joiner tab, in mm. */
export const JIGSAW_WIDTH_MM = 2;
const JIGSAW_OPENFACTOR = 0.3;
const JIGSAW_CLOSEFACTOR = 0.5;

/** Maximum skew of the slanted leading edge that marks the start of the song, in mm. */
export const MAX_START_SKEW_MM = 10;

/**
 * Minimum distance (mm) between the edge of a hole and the cut that separates two strips.
 * Prevents holes from being split or torn at the joints.
 */
export const CUT_CLEARANCE_MM = 0.5;

/** Vertical space between two strips on the same sheet, in mm. */
export const STRIP_SPACING_MM = 10;

/** Blank paper added after the last note, when there's room, in seconds. */
export const END_PADDING_SECONDS = 0.5;

/** All geometry is in millimeters, with the origin at the top-left corner and y pointing down. */
export interface ILine { x1: number; y1: number; x2: number; y2: number; }
export interface ICircle { cx: number; cy: number; r: number; }

/** A piece of the strip, i.e. a part of the song. */
export interface IStripPage {
    pageNum: number;

    /** The reference 'origin' in seconds since the start of song for this page. */
    startTimeInSeconds: number;

    /** Time at which this page ends (where the strip is cut). */
    endTimeInSeconds: number;

    /** The notes punched on this page. */
    notes: IMusicBoxNote[];
}

export interface IStripGeometry {
    /** Length of the strip from its leading to its trailing edge (without jigsaw tab). */
    lengthMm: number;
    /** Full horizontal extent, including a protruding jigsaw tab. */
    extentMm: number;
    /** Borders to cut. */
    lines: ILine[];
    /** Holes to punch. */
    circles: ICircle[];
}

export interface IPlacedStrip {
    /** Vertical position of the strip in the sheet. */
    offsetYMm: number;
    geometry: IStripGeometry;
}

export interface ISheet {
    widthMm: number;
    heightMm: number;
    strips: IPlacedStrip[];
}

export type LayoutMessageLevel = 'info' | 'warning';

export interface ILayoutMessage {
    level: LayoutMessageLevel;
    text: string;
}

export interface IMusicBoxLayout {
    extraction: INoteExtractionResult;
    pages: IStripPage[];
    sheets: ISheet[];
    totalPaperLengthMm: number;
    messages: ILayoutMessage[];
}

/**
 * Splits the notes into strip pages that fit the sheet width. Guarantees that:
 * - every hole is completely inside its page, at least {@link CUT_CLEARANCE_MM} away from a cut;
 * - no page (including a jigsaw tab) is longer than the sheet width.
 * Page breaks are placed in the middle between two notes whenever possible.
 */
export function paginateNotes(
    notes: IMusicBoxNote[],
    profile: IMusicBoxProfile,
    format: IMusicBoxSvgFormatOptions
): IStripPage[] {
    if (notes.length === 0) {
        throw new Error('No supported MIDI notes!');
    }

    const mmPerSecond = profile.millimetersPerSecond;
    const holeRadiusSeconds = (profile.holeDiameterMm * 0.5) / mmPerSecond;
    const clearanceSeconds = CUT_CLEARANCE_MM / mmPerSecond;
    // Space a hole needs on each side of its center before a cut.
    const holeMarginSeconds = holeRadiusSeconds + clearanceSeconds;

    let pageLengthInSeconds = Infinity;
    if (format.pageWidthMm > 0) {
        const usableWidthMm = format.pageWidthMm - (format.jigsawJoiners ? JIGSAW_WIDTH_MM : 0);
        if (usableWidthMm <= 0) {
            throw new Error('Sheet width is too small.');
        }
        pageLengthInSeconds = usableWidthMm / mmPerSecond;
    }

    const pages: IStripPage[] = [];

    // Add padding on the first page (set negative start time)
    let pageStart = -(format.startPaddingMm + profile.holeDiameterMm * 0.5) / mmPerSecond;
    let first = 0;

    while (first < notes.length) {
        const maxPageEnd = pageStart + pageLengthInSeconds;

        // Last note whose hole fits completely in this page.
        let lastFitting = first - 1;
        while (lastFitting + 1 < notes.length && notes[lastFitting + 1].timeSeconds + holeMarginSeconds <= maxPageEnd) {
            lastFitting++;
        }

        if (lastFitting < first) {
            throw new Error('Sheet width is too small to fit a single note.');
        }

        if (lastFitting === notes.length - 1) {
            // Last page. If there's room, add up to END_PADDING_SECONDS of blank paper.
            const lastNoteTime = notes[lastFitting].timeSeconds;
            pages.push({
                pageNum: pages.length,
                startTimeInSeconds: pageStart,
                endTimeInSeconds: Math.min(lastNoteTime + END_PADDING_SECONDS, maxPageEnd),
                notes: notes.slice(first),
            });
            break;
        }

        // Find the latest gap between two consecutive notes where the strip can be cut without
        // getting too close to any hole.
        let pageEnd: number | null = null;
        let lastOnPage = lastFitting;
        for (; lastOnPage >= first; lastOnPage--) {
            const before = notes[lastOnPage].timeSeconds;
            const after = notes[lastOnPage + 1].timeSeconds;
            const earliestCut = before + holeMarginSeconds;
            const latestCut = Math.min(after - holeMarginSeconds, maxPageEnd);
            if (earliestCut <= latestCut) {
                // Try to center the cut between notes on both sides, as much as possible.
                const middle = 0.5 * (before + after);
                pageEnd = Math.min(Math.max(middle, earliestCut), latestCut);
                break;
            }
        }

        if (pageEnd === null) {
            throw new Error('Page size too small to handle gaps between notes.');
        }

        pages.push({
            pageNum: pages.length,
            startTimeInSeconds: pageStart,
            endTimeInSeconds: pageEnd,
            notes: notes.slice(first, lastOnPage + 1),
        });

        pageStart = pageEnd;
        first = lastOnPage + 1;
    }

    return pages;
}

/** Vertical position (mm from the top edge of the strip) of every supported note. */
export function getNoteLinePositions(profile: IMusicBoxProfile): Map<MidiNote, number> {
    const noteCount = profile.supportedNotes.length;
    // Distance between two note lines
    const noteGap = profile.contentWidthMm / (noteCount - 1);
    const noteOffsetY = (profile.paperWidthMm - profile.contentWidthMm) / 2;

    // The highest note is at the top of the music box sheet.
    const positions = new Map<MidiNote, number>();
    [...profile.supportedNotes].sort((a, b) => a - b).forEach((note, i) => {
        positions.set(note, noteOffsetY + (noteCount - i - 1) * noteGap);
    });
    return positions;
}

function calculateStartSkew(format: IMusicBoxSvgFormatOptions): number {
    return Math.min(format.startPaddingMm, MAX_START_SKEW_MM);
}

function jigsawJoinerLines(xStart: number, height: number, profile: IMusicBoxProfile): ILine[] {
    // The gap on either side between content area and paper edge
    const gap = 0.5 * (profile.paperWidthMm - profile.contentWidthMm - profile.holeDiameterMm);

    const a = JIGSAW_OPENFACTOR; // open factor
    const b = JIGSAW_CLOSEFACTOR; // close factor

    const h = 0.5 * gap; // half gap

    const points = [
        // lower half
        { x: xStart, y: 0 },
        { x: xStart, y: h - a * h },
        { x: xStart + JIGSAW_WIDTH_MM, y: h - b * h },
        { x: xStart + JIGSAW_WIDTH_MM, y: h + b * h },
        { x: xStart, y: h + a * h },

        // upper half
        { x: xStart, y: height - h - a * h },
        { x: xStart + JIGSAW_WIDTH_MM, y: height - h - b * h },
        { x: xStart + JIGSAW_WIDTH_MM, y: height - h + b * h },
        { x: xStart, y: height - h + a * h },
        { x: xStart, y: height },
    ];

    const lines: ILine[] = [];
    for (let i = 0; i < points.length - 1; i++) {
        lines.push({ x1: points[i].x, y1: points[i].y, x2: points[i + 1].x, y2: points[i + 1].y });
    }
    return lines;
}

/** Borders and holes of one strip page, in strip coordinates. */
export function buildStripGeometry(
    page: IStripPage,
    pageCount: number,
    profile: IMusicBoxProfile,
    format: IMusicBoxSvgFormatOptions,
    notePositions: Map<MidiNote, number> = getNoteLinePositions(profile)
): IStripGeometry {
    const mmPerSecond = profile.millimetersPerSecond;
    const xLen = (page.endTimeInSeconds - page.startTimeInSeconds) * mmPerSecond;
    const yLen = profile.paperWidthMm;

    const isFirstPage = page.pageNum === 0;
    const isLastPage = page.pageNum === pageCount - 1;
    const drawLeadingBorder = !format.omitPageBoundaries || isFirstPage;
    const drawTrailingBorder = !format.omitPageBoundaries || isLastPage;
    const hasTrailingJigsaw = format.jigsawJoiners && !(isLastPage && !format.loopMode);

    const lines: ILine[] = [];
    if (format.renderBorder) {
        const topStart = isFirstPage && !format.loopMode ? calculateStartSkew(format) : 0;
        lines.push({ x1: topStart, y1: 0, x2: xLen, y2: 0 });
        lines.push({ x1: 0, y1: yLen, x2: xLen, y2: yLen });

        if (drawLeadingBorder) {
            if (isFirstPage && !format.loopMode) {
                // Special kind of leading border to identify the start
                lines.push({ x1: calculateStartSkew(format), y1: 0, x2: 0, y2: yLen });
            } else if (format.jigsawJoiners) {
                // Jigsaw joiner so that it can join with previous page
                // (also enabled in loop mode for first page)
                lines.push(...jigsawJoinerLines(0, yLen, profile));
            } else {
                lines.push({ x1: 0, y1: 0, x2: 0, y2: yLen });
            }
        }

        if (drawTrailingBorder) {
            if (hasTrailingJigsaw) {
                // Jigsaw joiner to connect to next page (also for last page in loop mode)
                lines.push(...jigsawJoinerLines(xLen, yLen, profile));
            } else {
                lines.push({ x1: xLen, y1: 0, x2: xLen, y2: yLen });
            }
        }
    }

    const circles: ICircle[] = page.notes.map(note => ({
        cx: (note.timeSeconds - page.startTimeInSeconds) * mmPerSecond,
        cy: notePositions.get(note.note) as number,
        r: profile.holeDiameterMm / 2,
    }));

    const tabMm = format.renderBorder && drawTrailingBorder && hasTrailingJigsaw ? JIGSAW_WIDTH_MM : 0;
    const geometry = { lengthMm: xLen, extentMm: xLen + tabMm, lines, circles };
    return format.mirrorVertically ? mirrorStripVertically(geometry, yLen) : geometry;
}

/** Mirrors a strip top <-> bottom around the middle of its paper width. Lengths don't change. */
export function mirrorStripVertically(strip: IStripGeometry, paperWidthMm: number): IStripGeometry {
    return {
        ...strip,
        lines: strip.lines.map(l => ({ x1: l.x1, y1: paperWidthMm - l.y1, x2: l.x2, y2: paperWidthMm - l.y2 })),
        circles: strip.circles.map(c => ({ cx: c.cx, cy: paperWidthMm - c.cy, r: c.r })),
    };
}

/** Arranges the strips in rows on sheets of the configured size. */
export function buildSheets(
    strips: IStripGeometry[],
    profile: IMusicBoxProfile,
    format: IMusicBoxSvgFormatOptions
): ISheet[] {
    // A horizontal strip uses the sheet width for its melody length, and the
    // paper tape's width for stacking multiple strips in rows.
    const stripPitch = profile.paperWidthMm + STRIP_SPACING_MM;
    const stripsPerSheet = format.pageHeightMm > 0
        // n strips need n * paperWidth + (n - 1) * spacing
        ? Math.floor((format.pageHeightMm + STRIP_SPACING_MM) / stripPitch + 1e-9)
        : strips.length;

    if (stripsPerSheet < 1) {
        throw new Error(
            `Sheet height must be at least ${profile.paperWidthMm.toFixed(2)} mm to fit one strip.`);
    }

    const sheets: ISheet[] = [];
    for (let first = 0; first < strips.length; first += stripsPerSheet) {
        const sheetStrips = strips.slice(first, first + stripsPerSheet);
        const placed = sheetStrips.map((geometry, j) => ({ offsetYMm: j * stripPitch, geometry }));
        sheets.push({
            widthMm: format.pageWidthMm > 0
                ? format.pageWidthMm
                : Math.max(...sheetStrips.map(s => s.extentMm)),
            heightMm: format.pageHeightMm > 0
                ? format.pageHeightMm
                : sheetStrips.length * profile.paperWidthMm + (sheetStrips.length - 1) * STRIP_SPACING_MM,
            strips: placed,
        });
    }
    return sheets;
}

/** Computes everything needed to preview, play and export the strips for a MIDI file. */
export function computeMusicBoxLayout(
    midiFile: MidiFile,
    profile: IMusicBoxProfile,
    format: IMusicBoxSvgFormatOptions,
    trackSelection: TrackSelection = 'auto'
): IMusicBoxLayout {
    const extraction = extractMusicBoxNotes(midiFile, profile, {
        transposeOutOfRangeNotes: format.transposeOutOfRangeNotes,
        includePercussion: format.includePercussion,
        trackSelection,
    });

    const pages = paginateNotes(extraction.notes, profile, format);
    const notePositions = getNoteLinePositions(profile);
    const strips = pages.map(page => buildStripGeometry(page, pages.length, profile, format, notePositions));
    const sheets = buildSheets(strips, profile, format);

    const messages: ILayoutMessage[] = [];
    if (extraction.transposedCount > 0) {
        messages.push({ level: 'info', text: `${extraction.transposedCount} notes transposed by whole octaves.` });
    }
    if (extraction.unsupportedCount > 0) {
        messages.push({
            level: 'warning',
            text: `${extraction.unsupportedCount} notes dropped: the music box can't play them` +
                (format.transposeOutOfRangeNotes ? ' in any octave.' : '. Try enabling transposition.'),
        });
    }
    if (extraction.tooCloseCount > 0) {
        messages.push({
            level: 'warning',
            text: `${extraction.tooCloseCount} notes skipped (too close to the previous hole on the same line). ` +
                'Try increasing mm/sec. MIDI may contain overlapping notes.',
        });
    }
    if (extraction.percussionCount > 0) {
        messages.push({ level: 'info', text: `${extraction.percussionCount} percussion notes ignored.` });
    }

    return {
        extraction,
        pages,
        sheets,
        totalPaperLengthMm: strips.reduce((total, strip) => total + strip.lengthMm, 0),
        messages,
    };
}
