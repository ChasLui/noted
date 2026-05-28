const FILTER_ID = 'noted-liquid-glass';
const MAP_ID = 'noted-liquid-glass-map';
const DISPLACEMENT_ID = 'noted-liquid-glass-displacement';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothStep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - (2 * t));
}

function length(x, y) {
  return Math.sqrt((x * x) + (y * y));
}

function roundedRectSdf(x, y, halfWidth, halfHeight, radius) {
  const qx = Math.abs(x) - halfWidth + radius;
  const qy = Math.abs(y) - halfHeight + radius;
  return Math.min(Math.max(qx, qy), 0) + length(Math.max(qx, 0), Math.max(qy, 0)) - radius;
}

function normalAt(x, y, halfWidth, halfHeight, radius) {
  const dx = roundedRectSdf(x + 1, y, halfWidth, halfHeight, radius)
    - roundedRectSdf(x - 1, y, halfWidth, halfHeight, radius);
  const dy = roundedRectSdf(x, y + 1, halfWidth, halfHeight, radius)
    - roundedRectSdf(x, y - 1, halfWidth, halfHeight, radius);
  const size = length(dx, dy) || 1;
  return { x: dx / size, y: dy / size };
}

function getRadius(target) {
  const value = parseFloat(getComputedStyle(target).borderRadius);
  return Number.isFinite(value) ? value : 16;
}

function renderDisplacementMap(target, filter, image, displacement) {
  const rect = target.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const radius = getRadius(target);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const bevel = clamp(Math.min(width, height) * 0.18, 34, 72);
  const scale = clamp(Math.min(width, height) * 0.038, 12, 24);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = context.createImageData(width, height);
  const data = imageData.data;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const centeredX = x - halfWidth;
      const centeredY = y - halfHeight;
      const distance = -roundedRectSdf(centeredX, centeredY, halfWidth, halfHeight, radius);
      const edge = 1 - smoothStep(0, bevel, distance);
      const lip = Math.sin(edge * Math.PI);
      const strength = clamp((edge * 0.76) + (lip * 0.24), 0, 1);
      const normal = normalAt(centeredX, centeredY, halfWidth, halfHeight, radius);
      const index = ((y * width) + x) * 4;

      data[index] = 128 + (normal.x * strength * 127);
      data[index + 1] = 128 + (normal.y * strength * 127);
      data[index + 2] = 128;
      data[index + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);

  filter.setAttribute('x', '0');
  filter.setAttribute('y', '0');
  filter.setAttribute('width', String(width));
  filter.setAttribute('height', String(height));
  image.setAttribute('width', String(width));
  image.setAttribute('height', String(height));
  image.setAttribute('href', canvas.toDataURL('image/png'));
  displacement.setAttribute('scale', String(scale));
}

export function initLiquidGlassFilter(target) {
  const filter = document.getElementById(FILTER_ID);
  const image = document.getElementById(MAP_ID);
  const displacement = document.getElementById(DISPLACEMENT_ID);
  if (!target || !filter || !image || !displacement) return;

  let frame = 0;
  const scheduleRender = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => renderDisplacementMap(target, filter, image, displacement));
  };

  scheduleRender();
  window.addEventListener('resize', scheduleRender);
  new ResizeObserver(scheduleRender).observe(target);
}
