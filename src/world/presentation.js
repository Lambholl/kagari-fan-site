/**
 * 按像素预算限制设备像素比并保持窗口宽高比。
 * 兼容模式（二维画布复制）上限为 1080p，直接显示 WebGL 时上限为 1440p，且最高不超过 1.75。
 */
export function scenePixelRatio(width, height, deviceRatio, compat) {
  const maxPixels = compat ? 1920 * 1080 : 2560 * 1440;
  return Math.min(deviceRatio, 1.75, Math.sqrt(maxPixels / (width * height)));
}

/** 兼容模式下复制 WebGL 帧到不透明二维画布显示，非兼容模式直接返回原画布。 */
export function createPresentation(source, compat) {
  if (!compat) return { canvas: source, resize() {}, present() {} };
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  return {
    canvas,
    resize() {
      canvas.width = source.width;
      canvas.height = source.height;
    },
    present() {
      ctx.drawImage(source, 0, 0);
    },
  };
}
