import {
  DEFAULT_ELEMENT_PROPS,
  getFontString,
  getLineHeight,
  randomId,
} from "@excalidraw/common";
import {
  measureText,
  normalizeText,
  wrapText,
  newElement,
  newTextElement,
  newFrameElement,
} from "@excalidraw/element";

import type {
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import type { AppState } from "../types";

export interface StoryboardScene {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  order: number;
}

const SCENES_PER_ROW = 5;
const FRAME_WIDTH = 320;
const FRAME_HEIGHT = Math.round((FRAME_WIDTH / 16) * 9);
const CARD_PADDING = 24;
const COLUMN_GAP = 80;
const ROW_GAP = 120;
const HEADER_GAP = 12;
const SPACING_FRAME_TO_NOTES = 20;
const NOTES_PADDING = 16;
const MIN_NOTES_HEIGHT = 96;

const toMilliseconds = (
  hours: number,
  minutes: number,
  seconds: number,
  milliseconds: number,
) => {
  return (
    ((hours * 60 + minutes) * 60 + seconds) * 1000 + Math.floor(milliseconds)
  );
};

const normalizeTimecode = (value: string) =>
  value
    .replace(/[–—−]/g, "-")
    .replace(/-\s*>/g, "->")
    .replace(/-+>/g, "->")
    .replace(/→/g, "->")
    .replace(/\s+/g, " ")
    .trim();

const TIME_LINE_REGEX =
  /(\d{1,2}):(\d{1,2}):(\d{1,2}),(\d{1,3})\s*->\s*(\d{1,2}):(\d{1,2}):(\d{1,2}),(\d{1,3})/;

const parseTimeLine = (value: string) => {
  const match = TIME_LINE_REGEX.exec(normalizeTimecode(value));
  if (!match) {
    return null;
  }
  const [
    ,
    sh,
    sm,
    ss,
    sms,
    eh,
    em,
    es,
    ems,
  ] = match.map((part) => part.trim());
  return {
    startMs: toMilliseconds(
      Number(sh),
      Number(sm),
      Number(ss),
      Number(sms.padEnd(3, "0")),
    ),
    endMs: toMilliseconds(
      Number(eh),
      Number(em),
      Number(es),
      Number(ems.padEnd(3, "0")),
    ),
  };
};

export const parseSRT = (input: string): StoryboardScene[] | null => {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const scenes: StoryboardScene[] = [];

  let currentIndex: number | null = null;
  let startMs: number | null = null;
  let endMs: number | null = null;
  let textLines: string[] = [];
  let order = 0;

  const pushCurrent = () => {
    if (startMs != null && endMs != null) {
      const text = normalizeText(textLines.join("\n")).trim();
      scenes.push({
        index:
          currentIndex != null
            ? currentIndex
            : scenes.length + 1,
        startMs,
        endMs: Math.max(startMs, endMs),
        text,
        order: order++,
      });
    }
    currentIndex = null;
    startMs = null;
    endMs = null;
    textLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (/^\d+$/.test(line)) {
      pushCurrent();
      currentIndex = Number(line);
      continue;
    }

    const timeInfo = parseTimeLine(line);
    if (timeInfo) {
      startMs = timeInfo.startMs;
      endMs = timeInfo.endMs;
      continue;
    }

    textLines.push(line);
  }

  pushCurrent();

  if (!scenes.length) {
    return null;
  }

  scenes.sort((a, b) => {
    if (a.index === b.index) {
      return a.order - b.order;
    }
    return a.index - b.index;
  });

  return scenes;
};

const formatTimeComponent = (value: number) =>
  String(Math.max(0, Math.floor(value))).padStart(2, "0");

const formatTimeRange = (startMs: number, endMs: number) => {
  const normalize = (ms: number) => {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${formatTimeComponent(hours)}:${formatTimeComponent(
        minutes,
      )}:${formatTimeComponent(seconds)}`;
    }
    return `${formatTimeComponent(minutes)}:${formatTimeComponent(seconds)}`;
  };

  return `${normalize(startMs)} - ${normalize(endMs)}`;
};

type StoryboardStyle = Pick<
  AppState,
  | "currentItemStrokeColor"
  | "currentItemBackgroundColor"
  | "currentItemFillStyle"
  | "currentItemRoughness"
  | "currentItemStrokeWidth"
  | "currentItemOpacity"
  | "currentItemFontFamily"
  | "currentItemFontSize"
>;

interface SceneLayout {
  headerHeight: number;
  cardHeight: number;
  wrappedNotes: string;
  noteRectHeight: number;
  numberHeight: number;
  timeHeight: number;
  timeWidth: number;
  cellHeight: number;
  timeLabel: string;
}

export const buildStoryboardElements = (
  scenes: StoryboardScene[],
  style: StoryboardStyle,
): readonly NonDeletedExcalidrawElement[] => {
  if (!scenes.length) {
    return [];
  }

  const fontFamily = style.currentItemFontFamily;
  const baseFontSize = style.currentItemFontSize;
  const numberFontSize = baseFontSize;
  const timeFontSize = Math.max(12, Math.round(baseFontSize * 0.85));
  const notesFontSize = Math.max(12, Math.round(baseFontSize * 0.8));

  const numberFont = getFontString({
    fontSize: numberFontSize,
    fontFamily,
  });
  const timeFont = getFontString({
    fontSize: timeFontSize,
    fontFamily,
  });
  const notesFont = getFontString({
    fontSize: notesFontSize,
    fontFamily,
  });

  const numberLineHeight = getLineHeight(fontFamily);
  const timeLineHeight = getLineHeight(fontFamily);
  const notesLineHeight = getLineHeight(fontFamily);

  const innerNoteWidth = FRAME_WIDTH - NOTES_PADDING * 2;

  const layouts: SceneLayout[] = scenes.map((scene) => {
    const numberMetrics = measureText(
      String(scene.index),
      numberFont,
      numberLineHeight,
    );
    const timeLabel = formatTimeRange(scene.startMs, scene.endMs);
    const timeMetrics = measureText(timeLabel, timeFont, timeLineHeight);

    const normalizedText = scene.text || "";
    const wrappedNotes = normalizedText
      ? wrapText(normalizedText, notesFont, innerNoteWidth)
      : "";

    const notesMetrics = wrappedNotes
      ? measureText(wrappedNotes, notesFont, notesLineHeight)
      : { width: 0, height: 0 };

    const noteRectHeight = Math.max(
      MIN_NOTES_HEIGHT,
      notesMetrics.height + NOTES_PADDING * 2,
    );

    const headerHeight =
      Math.max(numberMetrics.height, timeMetrics.height) + HEADER_GAP;
    const cardHeight =
      CARD_PADDING +
      FRAME_HEIGHT +
      SPACING_FRAME_TO_NOTES +
      noteRectHeight +
      CARD_PADDING;
    const cellHeight = headerHeight + cardHeight;

    return {
      headerHeight,
      cardHeight,
      wrappedNotes,
      noteRectHeight,
      numberHeight: numberMetrics.height,
      timeHeight: timeMetrics.height,
      timeWidth: timeMetrics.width,
      cellHeight,
      timeLabel,
    };
  });

  const cardWidth = FRAME_WIDTH + CARD_PADDING * 2;

  const rowHeights: number[] = [];
  layouts.forEach((layout, idx) => {
    const row = Math.floor(idx / SCENES_PER_ROW);
    rowHeights[row] = Math.max(
      rowHeights[row] ?? 0,
      layout.cellHeight + ROW_GAP,
    );
  });

  const rowOffsets: number[] = [];
  let accY = 0;
  for (let row = 0; row < rowHeights.length; row++) {
    rowOffsets[row] = accY;
    accY += rowHeights[row];
  }

  const elements: NonDeletedExcalidrawElement[] = [];

  scenes.forEach((scene, idx) => {
    const layout = layouts[idx];
    const col = idx % SCENES_PER_ROW;
    const row = Math.floor(idx / SCENES_PER_ROW);
    const baseX = col * (cardWidth + COLUMN_GAP);
    const baseY = rowOffsets[row] ?? 0;
    const groupId = randomId();

    const cardX = baseX;
    const cardY = baseY + layout.headerHeight;

    const cardFrame = newFrameElement({
      name: "",
      x: cardX,
      y: baseY,
      width: cardWidth,
      height: layout.cellHeight,
      strokeColor: style.currentItemStrokeColor,
      backgroundColor: "transparent",
      fillStyle: style.currentItemFillStyle,
      strokeWidth: style.currentItemStrokeWidth,
      roughness: style.currentItemRoughness,
      opacity: style.currentItemOpacity,
      groupIds: [groupId],
    });

    const numberElement = newTextElement({
      x: cardX,
      y: baseY,
      text: String(scene.index),
      fontSize: numberFontSize,
      fontFamily,
      strokeColor: style.currentItemStrokeColor,
      backgroundColor: DEFAULT_ELEMENT_PROPS.backgroundColor,
      textAlign: "left",
      verticalAlign: "top",
      groupIds: [groupId],
      frameId: cardFrame.id,
    });
    elements.push(numberElement);

    const timeElement = newTextElement({
      x: cardX + cardWidth,
      y: baseY,
      text: layout.timeLabel,
      fontSize: timeFontSize,
      fontFamily,
      strokeColor: style.currentItemStrokeColor,
      backgroundColor: DEFAULT_ELEMENT_PROPS.backgroundColor,
      textAlign: "right",
      verticalAlign: "top",
      groupIds: [groupId],
      frameId: cardFrame.id,
    });
    elements.push(timeElement);

    const outerRect = newElement({
      type: "rectangle",
      x: cardX,
      y: cardY,
      width: cardWidth,
      height: layout.cardHeight,
      strokeColor: style.currentItemStrokeColor,
      backgroundColor:
        style.currentItemBackgroundColor === "transparent"
          ? DEFAULT_ELEMENT_PROPS.backgroundColor
          : style.currentItemBackgroundColor,
      fillStyle: style.currentItemFillStyle,
      strokeWidth: style.currentItemStrokeWidth,
      roughness: style.currentItemRoughness,
      opacity: style.currentItemOpacity,
      groupIds: [groupId],
      frameId: cardFrame.id,
    });
    elements.push(outerRect);

    const frameX = cardX + CARD_PADDING;
    const frameY = cardY + CARD_PADDING;
    const frameElement = newElement({
      type: "rectangle",
      x: frameX,
      y: frameY,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      strokeColor: style.currentItemStrokeColor,
      backgroundColor: "transparent",
      fillStyle: style.currentItemFillStyle,
      strokeWidth: style.currentItemStrokeWidth,
      roughness: style.currentItemRoughness,
      opacity: style.currentItemOpacity,
      groupIds: [groupId],
      frameId: cardFrame.id,
    });
    elements.push(frameElement);

    const noteRect = newElement({
      type: "rectangle",
      x: frameX,
      y: frameY + FRAME_HEIGHT + SPACING_FRAME_TO_NOTES,
      width: FRAME_WIDTH,
      height: layout.noteRectHeight,
      strokeColor: style.currentItemStrokeColor,
      backgroundColor: DEFAULT_ELEMENT_PROPS.backgroundColor,
      fillStyle: style.currentItemFillStyle,
      strokeWidth: style.currentItemStrokeWidth,
      roughness: style.currentItemRoughness,
      opacity: style.currentItemOpacity,
      groupIds: [groupId],
      frameId: cardFrame.id,
    });
    elements.push(noteRect);

    if (layout.wrappedNotes) {
      const notesElement = newTextElement({
        x: frameX + NOTES_PADDING,
        y: noteRect.y + NOTES_PADDING,
        text: layout.wrappedNotes,
        originalText: scene.text,
        fontSize: notesFontSize,
        fontFamily,
        strokeColor: style.currentItemStrokeColor,
        backgroundColor: DEFAULT_ELEMENT_PROPS.backgroundColor,
        textAlign: "left",
        verticalAlign: "top",
        groupIds: [groupId],
        frameId: cardFrame.id,
      });
      elements.push(notesElement);
    }

    elements.push(cardFrame);
  });

  return elements;
};
