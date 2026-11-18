// 确定性伪随机数与二维噪声工具，保证每次打开看到的是同一座山丘。

/** 返回确定性伪随机数生成器，输出 0 到 1 之间的数。 */
export const mulberry32 = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hash2 = (ix: number, iy: number, seed: number) => {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const fade = (t: number) => t * t * (3 - 2 * t)

/** 返回二维值噪声函数，输出 0 到 1 之间的数。 */
export const makeNoise2D = (seed = 1) => {
  return (x: number, y: number) => {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const fx = fade(x - ix)
    const fy = fade(y - iy)
    const a = hash2(ix, iy, seed)
    const b = hash2(ix + 1, iy, seed)
    const c = hash2(ix, iy + 1, seed)
    const d = hash2(ix + 1, iy + 1, seed)
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
  }
}

/** 叠加多层二维分形噪声，输出约 0 到 1 之间的数。 */
export const fbm = (
  noise: (x: number, y: number) => number,
  x: number,
  y: number,
  octaves = 4,
  lacunarity = 2,
  gain = 0.5,
): number => {
  let amp = 0.5
  let freq = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq, y * freq)
    norm += amp
    amp *= gain
    freq *= lacunarity
  }
  return sum / norm
}

/** 将数值限制在上下界之间。 */
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
/** 线性插值。 */
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
/** 平滑阶跃插值，输出 0 到 1。 */
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}
/** 帧率无关的指数趋近。 */
export const damp = (cur: number, target: number, lambda: number, dt: number) =>
  lerp(cur, target, 1 - Math.exp(-lambda * dt))
