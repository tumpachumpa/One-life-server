export const DEFAULT_ANIMATION_FPS = 6;
export const DEFAULT_EFFECT_DURATION_MS = 2000;

const ALPHA_THRESHOLD = 10;
const WHITE_THRESHOLD = 245;
const sheetCache = new Map();

function isNearWhite(r, g, b) {
  return r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD;
}

function isActivePixel(data, index) {
  const alpha = data[index + 3];
  if (alpha <= ALPHA_THRESHOLD) return false;
  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  return !isNearWhite(r, g, b);
}

export function resolveVisualDefinition(visual, fallbackSprite = null) {
  if (!visual && !fallbackSprite) return null;
  if (typeof visual === "string") return { sprite: visual };
  if (visual?.animation || visual?.sprite) {
    return fallbackSprite && !visual.sprite && !visual.fallbackSprite
      ? { ...visual, fallbackSprite }
      : visual;
  }
  if (fallbackSprite) return { sprite: fallbackSprite };
  return null;
}

export function findActiveBands(flags = [], minGap = 2, minSpan = 1) {
  const bands = [];
  let start = -1;
  let gap = 0;

  for (let index = 0; index < flags.length; index++) {
    if (flags[index]) {
      if (start === -1) start = index;
      gap = 0;
      continue;
    }
    if (start === -1) continue;
    gap += 1;
    if (gap >= minGap) {
      const end = index - gap;
      if (end - start + 1 >= minSpan) bands.push({ start, end });
      start = -1;
      gap = 0;
    }
  }

  if (start !== -1) {
    const end = flags.length - 1 - gap;
    if (end - start + 1 >= minSpan) bands.push({ start, end });
  }

  return bands;
}

function tightenBounds(imageData, x0, x1, y0, y1) {
  const { width, data } = imageData;
  let minX = x1;
  let minY = y1;
  let maxX = x0;
  let maxY = y0;
  let found = false;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const index = (y * width + x) * 4;
      if (!isActivePixel(data, index)) continue;
      found = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (!found) return null;
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

export function inferSpriteSheetFramesFromImageData(imageData, options = {}) {
  const {
    minRowGap = 2,
    minColGap = 2,
    minBandSpan = 3,
    minAreaRatio = 0.08,
    maxFrames = null,
  } = options;
  const { width, height, data } = imageData;

  const activeRows = Array.from({ length: height }, (_, y) => {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      if (isActivePixel(data, index)) return true;
    }
    return false;
  });

  const rowBands = findActiveBands(activeRows, minRowGap, minBandSpan);
  const frames = [];

  for (const rowBand of rowBands) {
    const activeCols = Array.from({ length: width }, (_, x) => {
      for (let y = rowBand.start; y <= rowBand.end; y++) {
        const index = (y * width + x) * 4;
        if (isActivePixel(data, index)) return true;
      }
      return false;
    });

    const colBands = findActiveBands(activeCols, minColGap, minBandSpan);
    for (const colBand of colBands) {
      const bounds = tightenBounds(imageData, colBand.start, colBand.end, rowBand.start, rowBand.end);
      if (bounds) frames.push(bounds);
    }
  }

  if (!frames.length) {
    return [{ x: 0, y: 0, width, height }];
  }

  const maxArea = Math.max(...frames.map(frame => frame.width * frame.height));
  const filteredFrames = frames
    .filter(frame => frame.width * frame.height >= maxArea * minAreaRatio)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const startFrame = options.startFrame || 0;
  const framesFromStart = startFrame > 0 ? filteredFrames.slice(startFrame) : filteredFrames;
  const sliced = maxFrames ? framesFromStart.slice(0, maxFrames) : framesFromStart;
  const finalFrames = sliced.length > 0 ? sliced : filteredFrames.length > 0 ? filteredFrames : frames;
  if (!options.normalizeToMaxBounds || !finalFrames.length) return finalFrames;

  const maxWidth = Math.max(...finalFrames.map(frame => frame.width));
  const maxHeight = Math.max(...finalFrames.map(frame => frame.height));
  return finalFrames.map(frame => {
    const centerX = frame.x + frame.width / 2;
    const centerY = frame.y + frame.height / 2;
    const x = Math.max(0, Math.min(width - maxWidth, Math.round(centerX - maxWidth / 2)));
    const y = Math.max(0, Math.min(height - maxHeight, Math.round(centerY - maxHeight / 2)));
    return { x, y, width: maxWidth, height: maxHeight };
  });
}

function buildGridFrames(width, height, options = {}) {
  const frameWidth = Math.max(1, options.frameWidth || width);
  const frameHeight = Math.max(1, options.frameHeight || height);
  const frameX = options.frameX || 0;
  const frameY = options.frameY || 0;
  const frameStride = options.frameStride || frameWidth;
  const columns = Math.max(1, options.columns || Math.floor((width - frameX) / frameStride));
  const rows = Math.max(1, options.rows || Math.floor((height - frameY) / frameHeight));
  const frames = [];

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = frameX + column * frameStride;
      const y = frameY + row * frameHeight;
      if (x + frameWidth > width || y + frameHeight > height) continue;
      frames.push({ x, y, width: frameWidth, height: frameHeight });
    }
  }

  const start = options.startFrame || 0;
  const sliced = start > 0 ? frames.slice(start) : frames;
  const result = options.maxFrames ? sliced.slice(0, options.maxFrames) : sliced;
  return result.length > 0 ? result : frames;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load animation sheet: ${src}`));
    image.src = src;
  });
}

export async function loadSpriteSheetDefinition(src, options = {}) {
  const cacheKey = JSON.stringify({ src, options });
  if (sheetCache.has(cacheKey)) return sheetCache.get(cacheKey);

  const pending = loadImage(src).then(image => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    if (options.frameWidth || options.frameHeight) {
      const frames = buildGridFrames(canvas.width, canvas.height, options);
      return {
        src,
        width: canvas.width,
        height: canvas.height,
        frames,
        maxFrameWidth: Math.max(...frames.map(frame => frame.width)),
        maxFrameHeight: Math.max(...frames.map(frame => frame.height)),
      };
    }
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const frames = inferSpriteSheetFramesFromImageData(imageData, options);
    const maxFrameWidth = Math.max(...frames.map(frame => frame.width));
    const maxFrameHeight = Math.max(...frames.map(frame => frame.height));
    return {
      src,
      width: canvas.width,
      height: canvas.height,
      frames,
      maxFrameWidth,
      maxFrameHeight,
    };
  });

  sheetCache.set(cacheKey, pending);
  return pending;
}
