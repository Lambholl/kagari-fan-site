import * as THREE from 'three'

// 地面细节：草地和岩石的颜色全部由程序生成，远处用着色器里的非周期噪声，近处草地再叠加细节贴图，岩石只用三维噪声；烘焙贴图只用来找岩石的位置。

/** 烘焙贴图里草地的平均颜色（线性空间），程序草地的色板以它为均值，保持整体亮度不变。 */
const GRASS_BASE = [0.047, 0.09, 0.035]
/** 烘焙贴图里岩石的平均颜色（线性空间）。 */
const ROCK_BASE = [0.105, 0.088, 0.061]

const hash = (x: number, y: number, seed: number) => {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// 原地基 2 快速傅里叶变换，长度必须是 2 的幂；只用来合成随机相位的噪声，正反方向和缩放都不影响结果，所以只实现一个方向、不做归一化。
const fft = (re: Float64Array, im: Float64Array) => {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) {
      j ^= bit
    }
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const angle = (-2 * Math.PI) / len
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)
    for (let start = 0; start < n; start += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = start + k
        const b = a + half
        const tr = re[b]! * cr - im[b]! * ci
        const ti = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - tr
        im[b] = im[a]! - ti
        re[a] = re[a]! + tr
        im[a] = im[a]! + ti
        const next = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = next
      }
    }
  }
}

/**
 * 频域合成的无缝噪声：每个频率取随机相位、按 amplitude 给定振幅，再变换回空间域。
 * 频率都是整数周期，所以首尾相接，坡度在各处随机分布。
 * 返回均值 0、标准差 1 的 size × size 数组。
 */
const spectralNoise = (size: number, amplitude: (frequency: number) => number, seed: number) => {
  const count = size * size
  const re = new Float64Array(count)
  const im = new Float64Array(count)
  for (let y = 0; y < size; y++) {
    const fy = y <= size / 2 ? y : y - size
    for (let x = 0; x < size; x++) {
      const fx = x <= size / 2 ? x : x - size
      const f = Math.hypot(fx, fy)
      const a = f > 0 ? amplitude(f) : 0
      const phase = hash(x, y, seed) * Math.PI * 2
      re[y * size + x] = a * Math.cos(phase)
      im[y * size + x] = a * Math.sin(phase)
    }
  }
  const rowRe = new Float64Array(size)
  const rowIm = new Float64Array(size)
  for (let pass = 0; pass < 2; pass++) {
    // 第一遍按行、第二遍按列做一维变换。
    const stride = pass === 0 ? 1 : size
    const step = pass === 0 ? size : 1
    for (let line = 0; line < size; line++) {
      for (let i = 0; i < size; i++) {
        rowRe[i] = re[line * step + i * stride]!
        rowIm[i] = im[line * step + i * stride]!
      }
      fft(rowRe, rowIm)
      for (let i = 0; i < size; i++) {
        re[line * step + i * stride] = rowRe[i]!
        im[line * step + i * stride] = rowIm[i]!
      }
    }
  }
  // 相位不对称，结果是复数；实部本身就是同一频谱的随机场。
  let mean = 0
  for (let i = 0; i < count; i++) {
    mean += re[i]!
  }
  mean /= count
  let variance = 0
  for (let i = 0; i < count; i++) {
    variance += (re[i]! - mean) ** 2
  }
  const scale = 1 / Math.sqrt(variance / count || 1)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    out[i] = (re[i]! - mean) * scale
  }
  return out
}

// 平滑截掉低于 low 个周期的频率，避免出现与平铺尺寸相当的大块、暴露平铺周期。
const highPass = (f: number, low: number) => 1 - Math.exp(-((f / low) ** 4))

const normalize = (values: Float32Array) => {
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) {
      min = v
    }
    if (v > max) {
      max = v
    }
  }
  const range = max - min || 1
  for (let i = 0; i < values.length; i++) {
    values[i] = (values[i]! - min) / range
  }
}

/**
 * 生成无缝平铺的草地细节贴图。
 *
 * R 为草叶颗粒，G 为成团起伏的低频噪声，取值 0 至 1、均值约 0.5；B 恒为 0，A 恒为 1。
 * @param size - 边长（像素），必须是 2 的幂。
 * @returns 半浮点、线性色彩空间、重复平铺、带完整 mipmap 链的贴图。
 *   `userData.slope` 记录边长 `size`、两个通道的平均坡度平方（每像素高度差的平方，`grain`、`clump`），
 *   以及从第 0 级起每级 mipmap 保留的坡度能量比例（`grainRetained`、`clumpRetained`，首项为 1）。
 */
export const createGroundDetailTexture = (size = 512) => {
  const count = size * size
  // 草叶底纹：约 50 至 200 个周期的宽频噪声，再叠加逐像素随机值。
  const grainBase = spectralNoise(size, (f) => highPass(f, 48) * Math.exp(-((f / 160) ** 2)), 3)
  // 成团起伏：振幅按频率平方反比衰减，每高一个八度起伏减半，约 4 个周期以下截掉。
  const clumpBase = spectralNoise(
    size,
    (f) => (highPass(f, 4) * Math.exp(-((f / 80) ** 2))) / (f * f),
    11,
  )
  const grain = new Float32Array(count)
  const clump = new Float32Array(count)
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      grain[i] = 0.3 * clamp01(0.5 + 0.17 * grainBase[i]!) + 0.15 * hash(x, y, 5)
      // 标准差取 0.17，0.5 上下 3 个标准差约为 0 至 1，超出的极少数值截断。
      clump[i] = clamp01(0.5 + 0.17 * clumpBase[i]!)
    }
  }
  // 草叶：随机方向的短亮线，从斜上方看像一根根叶尖；绕边界取模保证平铺无缝。
  const bladeCount = Math.round(count / 40)
  for (let b = 0; b < bladeCount; b++) {
    const x0 = hash(b, 0, 41) * size
    const y0 = hash(b, 1, 41) * size
    const angle = hash(b, 2, 41) * Math.PI * 2
    const length = 2 + (hash(b, 3, 41) * size) / 96
    const light = 0.35 + 0.5 * hash(b, 4, 41)
    for (let s = 0; s <= length; s++) {
      const px = Math.floor(x0 + Math.cos(angle) * s) & (size - 1)
      const py = Math.floor(y0 + Math.sin(angle) * s) & (size - 1)
      const i = py * size + px
      grain[i] = Math.max(grain[i]!, light * (1 - (0.5 * s) / length))
    }
  }
  normalize(grain)
  // 存成半浮点：8 位存高度时每级 1/255，缓坡上连续几个像素取值相同、再跳一级，
  // 凹凸光照会沿等高线画出一圈圈环纹；半浮点在 0.5 至 1 之间每级约 1/2048，台阶小到看不出。
  // 在 CPU 上逐级 2×2 平均生成 mipmap，浮点贴图不能作为渲染目标的设备上也能用。
  const mipmaps = []
  // 每级 mipmap 里两个通道的坡度能量（第 0 级像素为单位），供着色器估算被过滤掉的起伏。
  const slopeEnergy: [number[], number[]] = [[], []]
  let levelSize = size
  let channels = [grain, clump]
  for (;;) {
    const texelScale = size / levelSize
    channels.forEach((src, c) =>
      slopeEnergy[c]!.push(meanSlopeSquared(src, levelSize) / (texelScale * texelScale)),
    )
    const data = new Uint16Array(levelSize * levelSize * 4)
    const one = THREE.DataUtils.toHalfFloat(1)
    for (let i = 0; i < levelSize * levelSize; i++) {
      data[i * 4] = THREE.DataUtils.toHalfFloat(channels[0]![i]!)
      data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(channels[1]![i]!)
      data[i * 4 + 3] = one
    }
    mipmaps.push({ data, width: levelSize, height: levelSize })
    if (levelSize === 1) {
      break
    }
    const next = levelSize >> 1
    channels = channels.map((src) => {
      const dst = new Float32Array(next * next)
      for (let y = 0; y < next; y++) {
        for (let x = 0; x < next; x++) {
          const i = 2 * y * levelSize + 2 * x
          dst[y * next + x] =
            (src[i]! + src[i + 1]! + src[i + levelSize]! + src[i + levelSize + 1]!) / 4
        }
      }
      return dst
    })
    levelSize = next
  }
  const texture = new THREE.DataTexture(
    mipmaps[0]!.data,
    size,
    size,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  )
  texture.mipmaps = mipmaps
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = false
  texture.anisotropy = 8
  texture.needsUpdate = true
  const slope = {
    size,
    grain: slopeEnergy[0][0]!,
    clump: slopeEnergy[1][0]!,
    grainRetained: slopeEnergy[0].map((e) => e / slopeEnergy[0][0]!),
    clumpRetained: slopeEnergy[1].map((e) => e / slopeEnergy[1][0]!),
  }
  return Object.assign(texture, { userData: { slope } })
}

// 无缝贴图的平均坡度平方：按相邻像素前向差分计算，与双线性插值后每格内的坡度一致。
const meanSlopeSquared = (values: Float32Array, n: number) => {
  let sum = 0
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = values[y * n + x]!
      const gx = values[y * n + ((x + 1) % n)]! - v
      const gy = values[((y + 1) % n) * n + x]! - v
      sum += gx * gx + gy * gy
    }
  }
  return sum / (n * n)
}

const vertexPars = /* glsl */ `
varying vec3 vGroundPos;
`

const vertexMain = /* glsl */ `
vGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`

const fragmentPars = /* glsl */ `
uniform sampler2D uGroundDetail;
varying vec3 vGroundPos;
const vec3 GRASS_BASE = vec3(${GRASS_BASE.join(', ')});
const vec3 ROCK_BASE = vec3(${ROCK_BASE.join(', ')});
const mat2 ROTATE_A = mat2(0.8, -0.6, 0.6, 0.8);
const mat2 ROTATE_B = mat2(-0.28, 0.96, -0.96, -0.28);

float groundHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 格点哈希不重复；五次插值让格子边上的一阶、二阶导数连续，放大看也没有格线或折痕。
float groundValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = groundHash(i);
  float b = groundHash(i + vec2(1.0, 0.0));
  float c = groundHash(i + vec2(0.0, 1.0));
  float d = groundHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float groundHash3(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// 三维值噪声直接按世界坐标取值，崖壁、斜坡和平顶都不需要投影，也就没有投影方向之间的过渡痕迹。
float groundValueNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = groundHash3(i);
  float n100 = groundHash3(i + vec3(1.0, 0.0, 0.0));
  float n010 = groundHash3(i + vec3(0.0, 1.0, 0.0));
  float n110 = groundHash3(i + vec3(1.0, 1.0, 0.0));
  float n001 = groundHash3(i + vec3(0.0, 0.0, 1.0));
  float n101 = groundHash3(i + vec3(1.0, 0.0, 1.0));
  float n011 = groundHash3(i + vec3(0.0, 1.0, 1.0));
  float n111 = groundHash3(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z
  );
}

// 一层宏观噪声：周期（米）小于约 4 个像素时淡出到均值 0.5，远处走动时不会闪烁。
float groundMacroOctave(vec2 p, float period, float footprint) {
  float fade = 1.0 - smoothstep(period * 0.12, period * 0.25, footprint);
  return mix(0.5, groundValueNoise(p / period), fade);
}

/** 远近通用的大片明暗，取值约 0.1 至 0.9、均值 0.5；每层旋转不同角度，避免格点沿坐标轴对齐。 */
float groundMacro(vec2 p, float footprint) {
  return groundMacroOctave(p + 13.7, 83.0, footprint) * 0.4
    + groundMacroOctave(ROTATE_A * p + 51.3, 31.0, footprint) * 0.27
    + groundMacroOctave(ROTATE_B * p + 7.9, 12.0, footprint) * 0.2
    + groundMacroOctave(ROTATE_A * ROTATE_B * p + 23.1, 4.7, footprint) * 0.13;
}

vec2 groundOffset(float n) {
  return fract(sin(vec2(n * 12.9898, n * 78.233 + 1.7)) * 43758.5453);
}

// 哈希偏移：低频噪声 k 决定在哪两套随机平移的采样之间过渡，打乱细节贴图的平铺周期。
// 两次采样共用原坐标的导数，平移处不会因 mip 跳级出现接缝；过渡中按方差补偿对比度，避免混合处发灰。
vec4 groundSampleNoTile(vec2 uv, vec2 dx, vec2 dy, float k) {
  float l = k * 6.0;
  float i = floor(l);
  float w = smoothstep(0.25, 0.75, fract(l));
  vec4 a = textureGrad(uGroundDetail, uv + groundOffset(i), dx, dy);
  vec4 b = textureGrad(uGroundDetail, uv + groundOffset(i + 1.0), dx, dy);
  return 0.5 + (mix(a, b, w) - 0.5) / sqrt(w * w + (1.0 - w) * (1.0 - w));
}

// 草地两层起伏的高度（米）和采样频率（每米多少个贴图周期），坡度方差估算与采样共用。
const float GRAIN_AMP = 0.008;
const float GRAIN_FREQ = 0.8;
const float CLUMP_AMP = 0.04;
const float CLUMP_SMALL_FREQ = 0.19;
const float CLUMP_LARGE_FREQ = 0.071;
const float CLUMP_SMALL_WEIGHT = 0.7;
const float CLUMP_LARGE_WEIGHT = 0.6;

/** 草叶颗粒，平铺尺寸 1.25 米；dp 为当前像素位置到相邻像素的世界坐标差。 */
float grassGrain(vec2 p, vec2 dpx, vec2 dpy, float k) {
  return groundSampleNoTile(p * GRAIN_FREQ, dpx * GRAIN_FREQ, dpy * GRAIN_FREQ, k).r;
}

/**
 * 成团起伏，均值 0.5。同一张贴图按约 5.3 米和 14 米两种平铺尺寸、两个角度各采样一次再叠加：
 * 单一尺寸的团块大小一致、分布均匀，放大看远处时很规律；两种尺寸的比例不是整数，叠加后的图案不会对齐重复。
 * k 的两个分量分别给两次采样做哈希偏移。
 */
float grassClump(vec2 p, vec2 dpx, vec2 dpy, vec2 k) {
  const float s = CLUMP_SMALL_FREQ;
  const float l = CLUMP_LARGE_FREQ;
  float small = groundSampleNoTile(ROTATE_A * p * s, ROTATE_A * dpx * s, ROTATE_A * dpy * s, k.x).g;
  float large = groundSampleNoTile(ROTATE_B * p * l + 0.37, ROTATE_B * dpx * l, ROTATE_B * dpy * l, k.y).g;
  // 两次采样互不相关，系数平方和约为 0.85，叠加后对比度与单次采样相近。
  return 0.5 + (small - 0.5) * CLUMP_SMALL_WEIGHT + (large - 0.5) * CLUMP_LARGE_WEIGHT;
}

/** 草地起伏高度（米）；fineFade、clumpFade 为 0 时分别去掉草叶颗粒和成团起伏；k.x 给草叶颗粒、k.yz 给成团起伏做哈希偏移。 */
float grassHeight(vec2 p, vec2 dpx, vec2 dpy, vec3 k, float fineFade, float clumpFade) {
  return (grassGrain(p, dpx, dpy, k.x) - 0.5) * GRAIN_AMP * fineFade + (grassClump(p, dpx, dpy, k.yz) - 0.5) * CLUMP_AMP * clumpFade;
}

// 一层贴图起伏在屏幕上还能画出的坡度能量比例。spacing 为相邻像素在地面上的距离（米），freq 为该层每米的贴图周期数；
// 按 spacing 覆盖的贴图像素数换算 mipmap 级别，再查表。
float detailRetained(float retained[DETAIL_LEVELS], float spacing, float freq) {
  float lod = clamp(log2(spacing * freq * DETAIL_SIZE), 0.0, float(DETAIL_LEVELS - 1));
  int i = int(lod);
  return mix(retained[i], retained[min(i + 1, DETAIL_LEVELS - 1)], fract(lod));
}

// 一层起伏被 mipmap 过滤和淡出去掉的坡度方差（世界坐标下坡度的平方）；
// energy 为贴图每像素高度差的平方，scale 为贴图取值到米的换算，屏幕两个方向分别估算后取平均。
float detailLostSlope2(float retained[DETAIL_LEVELS], float energy, float scale, float freq, float fade, vec2 steps) {
  float texelSlope = scale * freq * DETAIL_SIZE;
  float kept = 0.5 * (detailRetained(retained, steps.x, freq) + detailRetained(retained, steps.y, freq)) * fade * fade;
  return energy * texelSlope * texelSlope * (1.0 - kept);
}

/**
 * 草地起伏中画不出来的坡度方差，供 Toksvig 法缩短法线、加大粗糙度。
 * 近处凹凸光照下各像素法线朝向不一，平均亮度比平地低；远处起伏被过滤掉后按平地着色会偏亮，这里把差值补回去。
 */
float grassLostSlope2(vec2 steps, float fineFade, float clumpFade) {
  return detailLostSlope2(GRAIN_RETAINED, GRAIN_SLOPE2, GRAIN_AMP, GRAIN_FREQ, fineFade, steps)
    + detailLostSlope2(CLUMP_RETAINED, CLUMP_SLOPE2, CLUMP_AMP * CLUMP_SMALL_WEIGHT, CLUMP_SMALL_FREQ, clumpFade, steps)
    + detailLostSlope2(CLUMP_RETAINED, CLUMP_SLOPE2, CLUMP_AMP * CLUMP_LARGE_WEIGHT, CLUMP_LARGE_FREQ, clumpFade, steps);
}

/** 岩面采样坐标的低频扭曲，让脊状折痕弯曲断续；只随位置缓慢变化，相邻像素可共用同一个偏移。 */
vec3 rockWarp(vec3 p) {
  vec3 q = p / 7.0;
  return 0.9 * vec3(groundValueNoise3(q), groundValueNoise3(q + 19.1), groundValueNoise3(q + 41.7)) - 0.45;
}

/**
 * 岩面纹理，取值 0 至 1、均值约 0.5。五层脊状值噪声，周期从 5 米缩到约 0.2 米；
 * 竖直方向频率乘 1.6，崖壁上拉成水平岩层；每层绕竖直轴旋转，格点不沿坐标轴对齐；周期小于约 4 个像素的层淡出，远看不闪烁。
 */
float rockPattern(vec3 p, float footprint) {
  vec3 q = vec3(p.x, p.y * 1.6, p.z);
  float sum = 0.0;
  float norm = 0.0;
  float amp = 1.0;
  float period = 5.0;
  for (int o = 0; o < 5; o++) {
    float n = 1.0 - abs(2.0 * groundValueNoise3(q / period + float(o) * 7.3) - 1.0);
    sum += mix(0.5, n, 1.0 - smoothstep(period * 0.12, period * 0.25, footprint)) * amp;
    norm += amp;
    q.xz = ROTATE_A * q.xz;
    period *= 0.45;
    amp *= 0.6;
  }
  return sum / norm;
}

/** 岩面起伏高度（米）。 */
float rockHeight(vec3 p, float footprint) {
  return (rockPattern(p, footprint) - 0.5) * 0.12;
}
`

// 替换 map_fragment：diffuseColor 乘以程序生成的地面颜色，groundBumpGrad 记录细节高度沿屏幕 x、y 方向相邻像素的差（米）供法线扰动。
// 高度差用相邻像素位置重新采样得到，而不是对高度求 dFdx：后者在斜看崖壁时按 2×2 像素块跳变，会画出细密的横纹。
const albedoFragment = /* glsl */ `
vec3 groundAlbedo;
vec2 groundBumpGrad;
float groundLostSlope2;
{
  vec3 dpx = dFdx(vGroundPos);
  vec3 dpy = dFdy(vGroundPos);
  vec2 p = vGroundPos.xz;
  // 按一个像素盖住的地面宽度（米）逐层淡出细节：近处叠加贴图里的草叶颗粒和成团起伏，
  // 远处只留非周期噪声给出的大片明暗和色调，既不重复也不会在走动时闪烁。
  float footprint = max(length(dpx), length(dpy));
  float fineFade = 1.0 - smoothstep(0.004, 0.015, footprint);
  float clumpFade = 1.0 - smoothstep(0.02, 0.1, footprint);
  float macroShade = groundMacro(p, footprint);
  float hue = smoothstep(0.2, 0.8, groundValueNoise(ROTATE_B * p / 170.0 + 3.1));
  // 每个因子均值约为 1，叠加后草地平均颜色仍是 GRASS_BASE。
  vec3 grass = GRASS_BASE * mix(vec3(0.86, 1.03, 1.1), vec3(1.16, 0.98, 0.86), hue) * (0.3 + 1.4 * macroShade);
  // 烘焙贴图中远处地面在 400 米内亮度基本不变，700 米外降到约 35%，这里用平滑的径向渐变代替。
  grass *= mix(1.0, 0.35, smoothstep(350.0, 800.0, length(p)));
  groundBumpGrad = vec2(0.0);
  groundLostSlope2 = grassLostSlope2(vec2(length(dpx), length(dpy)), fineFade, clumpFade);
  // 细节完全淡出的远处跳过贴图采样。
  if (clumpFade > 0.0) {
    vec3 k = vec3(groundValueNoise(p * 0.55 + 5.3), groundValueNoise(p * 0.09 + 9.1), groundValueNoise(p * 0.035 + 1.7));
    float grain = grassGrain(p, dpx.xz, dpy.xz, k.x);
    float clump = grassClump(p, dpx.xz, dpy.xz, k.yz);
    grass *= (1.0 + (0.8 * clump - 0.4) * clumpFade) * (1.0 + (0.8 * grain - 0.4) * fineFade);
    float h = (grain - 0.5) * GRAIN_AMP * fineFade + (clump - 0.5) * CLUMP_AMP * clumpFade;
    groundBumpGrad = vec2(
      grassHeight(p + dpx.xz, dpx.xz, dpy.xz, k, fineFade, clumpFade) - h,
      grassHeight(p + dpy.xz, dpx.xz, dpy.xz, k, fineFade, clumpFade) - h
    );
  }
  groundAlbedo = grass;
#ifdef GROUND_ROCK
  // 抬高 2 级 mip，相当于从 4096 像素降到 1024 像素，只取烘焙贴图的低频颜色来找岩石的位置。
  vec3 macro = texture2D(map, vMapUv, 2.0).rgb;
  // 烘焙贴图中岩石偏灰褐、草地偏绿，按绿色程度区分；中间值是长了苔藓的岩石。
  float greenness = macro.g - 0.5 * (macro.r + macro.b);
  float rock = 1.0 - smoothstep(0.016, 0.034, greenness);
  if (rock > 0.001) {
    vec3 rockPos = vGroundPos + rockWarp(vGroundPos);
    float rockDetail = rockPattern(rockPos, footprint);
    // 岩石颜色也不取烘焙贴图：放大后的烘焙像素在近处会拖出模糊条纹。
    vec3 rockColor = ROCK_BASE * (0.5 + rockDetail) * (0.6 + 0.8 * macroShade);
    groundAlbedo = mix(grass, rockColor, rock);
    // 一个像素盖住半米以上的岩面时起伏已看不出，跳过重新采样。
    float rockFade = 1.0 - smoothstep(0.1, 0.5, footprint);
    vec2 rockGrad = vec2(0.0);
    if (rockFade > 0.0) {
      float r = (rockDetail - 0.5) * 0.12;
      rockGrad = vec2(rockHeight(rockPos + dpx, footprint) - r, rockHeight(rockPos + dpy, footprint) - r) * rockFade;
    }
    groundBumpGrad = mix(groundBumpGrad, rockGrad, rock);
    // 坡度方差只统计了草地细节贴图，按岩石比例把补偿减掉，岩面按原法线着色。
    groundLostSlope2 *= 1.0 - rock;
  }
#endif
  diffuseColor.rgb *= groundAlbedo;
}
`

// 沿用 bumpmap 的屏幕空间导数做法，在法线贴图的结果上再叠加程序细节的起伏。
const bumpFragment = /* glsl */ `
{
  vec3 sigmaX = dFdx(-vViewPosition);
  vec3 sigmaY = dFdy(-vViewPosition);
  vec3 r1 = cross(sigmaY, normal);
  vec3 r2 = cross(normal, sigmaX);
  float det = dot(sigmaX, r1) * faceDirection;
  vec3 grad = sign(det) * (groundBumpGrad.x * r1 + groundBumpGrad.y * r2);
  normal = normalize(abs(det) * normal - grad);
  // Toksvig：一个像素内法线的平均值比单位长度短，坡度方差为 σ² 时约为 1/sqrt(1+σ²)。
  // 平行光和半球光的漫反射都与法线点乘，缩短后远处被过滤掉起伏的地面与近处凹凸地面的平均亮度一致。
  normal *= inversesqrt(1.0 + groundLostSlope2);
}
`

// GGX 坡度分布的方差为 α²（α 为粗糙度的平方），叠加画不出来的坡度方差后再换回粗糙度。
const roughnessFragment = /* glsl */ `
roughnessFactor = sqrt(sqrt(min(1.0, pow4(roughnessFactor) + groundLostSlope2)));
`

// 细节贴图的坡度统计，生成贴图时算出，写成着色器常量。
type GroundDetailTexture = ReturnType<typeof createGroundDetailTexture>

const slopeConstants = ({
  size,
  grain,
  clump,
  grainRetained,
  clumpRetained,
}: GroundDetailTexture['userData']['slope']) => {
  const list = (values: number[]) => values.map((v) => v.toFixed(6)).join(', ')
  return /* glsl */ `
#define DETAIL_LEVELS ${grainRetained.length}
const float DETAIL_SIZE = ${size.toFixed(1)};
const float GRAIN_SLOPE2 = ${grain.toExponential(6)};
const float CLUMP_SLOPE2 = ${clump.toExponential(6)};
const float GRAIN_RETAINED[DETAIL_LEVELS] = float[DETAIL_LEVELS](${list(grainRetained)});
const float CLUMP_RETAINED[DETAIL_LEVELS] = float[DETAIL_LEVELS](${list(clumpRetained)});
`
}

/**
 * 把地形材质的颜色改为程序地面细节，并让自发光跟随新的颜色；会覆盖材质原有的 onBeforeCompile。
 * @param material - 反照率和自发光使用同一张烘焙贴图。
 * @param options - `hasRock` 启用烘焙贴图里的岩石识别，适用于草地偏绿、岩石偏灰褐的贴图。
 */
export const applyGroundDetail = (
  material: THREE.MeshStandardMaterial,
  { detail, hasRock }: { detail: GroundDetailTexture; hasRock: boolean },
): void => {
  if (hasRock) {
    material.defines = { ...material.defines, GROUND_ROCK: '' }
  }
  material.customProgramCacheKey = () => `ground-detail-${hasRock}`
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGroundDetail = { value: detail }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexPars}`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${vertexMain}`)
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${slopeConstants(detail.userData.slope)}\n${fragmentPars}`,
      )
      .replace('#include <map_fragment>', albedoFragment)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\n${roughnessFragment}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n${bumpFragment}`,
      )
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance *= groundAlbedo;')
  }
  material.needsUpdate = true
}
