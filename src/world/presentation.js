/** 兼容显示采用 1080p 像素预算；窄屏仍保留相同的宽高比。 */
export function scenePixelRatio(width, height, deviceRatio, compat) {
  const maxPixels = compat ? 1920 * 1080 : 2560 * 1440;
  return Math.min(deviceRatio, 1.75, Math.sqrt(maxPixels / (width * height)));
}

/** 让页面只合成不透明的 2D 画布，WebGL 帧在绘制结束后一次复制。 */
export function createPresentation(source, compat) {
  if (!compat) return { canvas: source, resize() {}, present() {} };
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
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
