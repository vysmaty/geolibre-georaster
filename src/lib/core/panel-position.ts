export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface PanelPosition {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

const GAP = 6;
const MARGIN = 12;

export function calculatePanelPosition(
  button: RectLike,
  map: RectLike,
  panelWidth: number,
  panelHeight: number,
): PanelPosition {
  const opensFromLeft =
    button.left + button.width / 2 < map.left + map.width / 2;
  const opensFromTop =
    button.top + button.height / 2 < map.top + map.height / 2;
  const maxLeft = Math.max(MARGIN, map.width - panelWidth - MARGIN);
  const maxTop = Math.max(MARGIN, map.height - panelHeight - MARGIN);

  if (opensFromLeft) {
    const left = Math.min(maxLeft, Math.max(MARGIN, button.left - map.left));
    if (opensFromTop) {
      return {
        left,
        top: Math.min(maxTop, Math.max(MARGIN, button.bottom - map.top + GAP)),
      };
    }
    return {
      left,
      bottom: Math.min(maxTop, Math.max(MARGIN, map.bottom - button.top + GAP)),
    };
  }

  const right = Math.min(maxLeft, Math.max(MARGIN, map.right - button.right));
  if (opensFromTop) {
    return {
      right,
      top: Math.min(maxTop, Math.max(MARGIN, button.bottom - map.top + GAP)),
    };
  }
  return {
    right,
    bottom: Math.min(maxTop, Math.max(MARGIN, map.bottom - button.top + GAP)),
  };
}
