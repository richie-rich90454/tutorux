export type InlineMarkdownFormat = "bold" | "italic" | "strike" | "code" | "link";

export interface FormattedMarkdownSelection {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: "forward" | "backward" | "none";
}

/** Apply the journal editor's portable Markdown formatting to a UTF-16 selection. */
export function formatMarkdownSelection(
  text: string,
  anchorOffset: number,
  focusOffset: number,
  format: InlineMarkdownFormat,
): FormattedMarkdownSelection {
  const anchor = clampOffset(text, anchorOffset);
  const focus = clampOffset(text, focusOffset);
  const start = Math.min(anchor, focus);
  const end = Math.max(anchor, focus);
  const marker =
    format === "bold"
      ? "**"
      : format === "italic"
        ? "*"
        : format === "strike"
          ? "~~"
          : format === "code"
            ? "`"
            : "";

  if (format === "link") {
    if (
      end > start &&
      start > 0 &&
      end + 1 < text.length &&
      text[start - 1] === "[" &&
      text[end] === "]" &&
      text[end + 1] === "("
    ) {
      const targetEnd = text.indexOf(")", end + 2);
      if (targetEnd !== -1) {
        const unlinked =
          text.slice(0, start - 1) + text.slice(start, end) + text.slice(targetEnd + 1);
        const newStart = start - 1;
        const newEnd = end - 1;
        return orientedSelection(
          unlinked,
          anchor <= focus ? newStart : newEnd,
          anchor <= focus ? newEnd : newStart,
        );
      }
    }

    const selected = text.slice(start, end);
    const linked = `${text.slice(0, start)}[${selected}](url)${text.slice(end)}`;
    if (selected.length === 0) {
      return {
        text: linked,
        selectionStart: start + 3,
        selectionEnd: start + 6,
        selectionDirection: "forward",
      };
    }
    const urlStart = start + selected.length + 3;
    return {
      text: linked,
      selectionStart: urlStart,
      selectionEnd: urlStart + 3,
      selectionDirection: "forward",
    };
  }

  if (end > start && marker.length > 0) {
    let openingStarRun = 0;
    for (let offset = start; offset > 0 && text[offset - 1] === "*"; offset -= 1)
      openingStarRun += 1;
    let closingStarRun = 0;
    for (let offset = end; offset < text.length && text[offset] === "*"; offset += 1)
      closingStarRun += 1;
    const italicWouldRemoveBold = marker === "*" && openingStarRun === 2 && closingStarRun === 2;
    if (
      !italicWouldRemoveBold &&
      start >= marker.length &&
      text.slice(start - marker.length, start) === marker &&
      text.slice(end, end + marker.length) === marker
    ) {
      const result =
        text.slice(0, start - marker.length) +
        text.slice(start, end) +
        text.slice(end + marker.length);
      const newStart = start - marker.length;
      const newEnd = end - marker.length;
      return orientedSelection(
        result,
        anchor <= focus ? newStart : newEnd,
        anchor <= focus ? newEnd : newStart,
      );
    }
  }

  const wrapped = `${text.slice(0, start)}${marker}${text.slice(start, end)}${marker}${text.slice(end)}`;
  const markerSize = marker.length;
  if (start === end) {
    return {
      text: wrapped,
      selectionStart: start + markerSize,
      selectionEnd: start + markerSize,
      selectionDirection: "none",
    };
  }
  const newStart = start + markerSize;
  const newEnd = end + markerSize;
  return orientedSelection(
    wrapped,
    anchor <= focus ? newStart : newEnd,
    anchor <= focus ? newEnd : newStart,
  );
}

function clampOffset(text: string, offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  const bounded = Math.max(0, Math.min(text.length, Math.trunc(offset)));
  if (
    bounded > 0 &&
    bounded < text.length &&
    isHighSurrogate(text.charCodeAt(bounded - 1)) &&
    isLowSurrogate(text.charCodeAt(bounded))
  ) {
    return bounded - 1;
  }
  return bounded;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function orientedSelection(
  text: string,
  anchor: number,
  focus: number,
): FormattedMarkdownSelection {
  return {
    text,
    selectionStart: Math.min(anchor, focus),
    selectionEnd: Math.max(anchor, focus),
    selectionDirection: anchor === focus ? "none" : anchor <= focus ? "forward" : "backward",
  };
}
