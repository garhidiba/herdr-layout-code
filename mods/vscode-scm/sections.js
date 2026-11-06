// VS Code's Source Control view layout, as pure math (no Herdr imports, so node tests load it).
// Sections are in order: { id, open, size (stored px or undefined), min }. Only open sections get a height.

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// The open sections share `available` px: each keeps its stored size (earlier sections first) as long as the
// rest can still have their minimum; the flex section (`flexId` when open, else the last open one) takes the rest.
export const flexSection = (sections, flexId) => {
  const open = sections.filter((s) => s.open);
  return open.find((s) => s.id === flexId) ?? open[open.length - 1];
};

export function layoutSections(sections, available, flexId) {
  const open = sections.filter((s) => s.open), heights = {}, flex = flexSection(sections, flexId);
  let spare = Math.max(0, available - open.reduce((n, s) => n + s.min, 0));
  for (const s of open) {
    if (s === flex) continue;
    heights[s.id] = clamp(s.size ?? s.min, s.min, s.min + spare);
    spare -= heights[s.id] - s.min;
  }
  if (flex) heights[flex.id] = flex.min + spare;
  return heights;
}

// The sash on the top edge of section `index`: the nearest open section above it and the nearest open one
// at or below it, or null when either side has none.
export function sashPair(sections, index) {
  const up = sections.slice(0, index).reverse().find((s) => s.open), down = sections.slice(index).find((s) => s.open);
  return index > 0 && up && down ? [up.id, down.id] : null;
}

// Dragging that sash by `dy` px (down is positive) grows one section and shrinks the other, neither below its minimum.
export function dragSash(heights, mins, [up, down], dy) {
  const d = clamp(dy, mins[up] - heights[up], heights[down] - mins[down]);
  return { [up]: heights[up] + d, [down]: heights[down] - d };
}
