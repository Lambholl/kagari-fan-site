import * as THREE from 'three';

// 地面细节：草地和岩石的颜色全部由程序生成，远处用着色器里的非周期噪声，近处草地再叠加细节贴图，岩石只用三维噪声；烘焙贴图只用来找岩石的位置。

/** 烘焙贴图里草地的平均颜色（线性空间），程序草地的色板以它为均值，保持整体亮度不变。 */
const GRASS_BASE = [0.047, 0.09, 0.035];
/** 烘焙贴图里岩石的平均颜色（线性空间）。 */
const ROCK_BASE = [0.105, 0.088, 0.061];

function hash(x, y, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * (3 - 2 * t);

/** u、v 取 0 至 1，period 个格点后首尾相接，用于生成无缝平铺的贴图。 */
function periodicNoise(u, v, period, seed) {
  const x = u * period;
  const y = v * period;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = fade(x - xi);
  const fy = fade(y - yi);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = hash(x0, y0, seed);
  const b = hash(x1, y0, seed);
  const c = hash(x0, y1, seed);
  const d = hash(x1, y1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function periodicFbm(u, v, period, octaves, seed) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += periodicNoise(u, v, period << o, seed + o * 17) * amp;
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

function normalize(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  for (let i = 0; i < values.length; i++) values[i] = (values[i] - min) / range;
}

/**
 * 生成无缝平铺的草地细节贴图。
 *
 * R 为草叶颗粒，G 为成团起伏的低频噪声，取值 0 至 1、均值约 0.5；B 恒为 0，A 恒为 1。
 * @param {number} [size=512] - 边长（像素），必须是 2 的幂。
 * @returns {THREE.DataTexture} 线性色彩空间、重复平铺、带 mipmap 的贴图。
 */
export function createGroundDetailTexture(size = 512) {
  const count = size * size;
  const grain = new Float32Array(count);
  const clump = new Float32Array(count);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = y / size;
      grain[i] = 0.3 * periodicNoise(u, v, size >> 2, 3) + 0.15 * hash(x, y, 5);
      clump[i] = periodicFbm(u, v, 4, 5, 11);
    }
  }
  // 草叶：随机方向的短亮线，从斜上方看像一根根叶尖；绕边界取模保证平铺无缝。
  const bladeCount = Math.round(count / 40);
  for (let b = 0; b < bladeCount; b++) {
    const x0 = hash(b, 0, 41) * size;
    const y0 = hash(b, 1, 41) * size;
    const angle = hash(b, 2, 41) * Math.PI * 2;
    const length = 2 + hash(b, 3, 41) * size / 96;
    const light = 0.35 + 0.5 * hash(b, 4, 41);
    for (let s = 0; s <= length; s++) {
      const px = Math.floor(x0 + Math.cos(angle) * s) & (size - 1);
      const py = Math.floor(y0 + Math.sin(angle) * s) & (size - 1);
      const i = py * size + px;
      grain[i] = Math.max(grain[i], light * (1 - 0.5 * s / length));
    }
  }
  normalize(grain);
  normalize(clump);
  const data = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    data[i * 4] = Math.round(grain[i] * 255);
    data[i * 4 + 1] = Math.round(clump[i] * 255);
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

const vertexPars = /* glsl */ `
varying vec3 vGroundPos;
`;

const vertexMain = /* glsl */ `
vGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

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

/** 草叶颗粒，平铺尺寸 1.25 米；dp 为当前像素位置到相邻像素的世界坐标差。 */
float grassGrain(vec2 p, vec2 dpx, vec2 dpy, float k) {
  return groundSampleNoTile(p * 0.8, dpx * 0.8, dpy * 0.8, k).r;
}

/** 成团起伏，平铺尺寸约 5.3 米。 */
float grassClump(vec2 p, vec2 dpx, vec2 dpy, float k) {
  return groundSampleNoTile(ROTATE_A * p * 0.19, ROTATE_A * dpx * 0.19, ROTATE_A * dpy * 0.19, k).g;
}

/** 草地起伏高度（米）；fineFade、clumpFade 为 0 时分别去掉草叶颗粒和成团起伏。 */
float grassHeight(vec2 p, vec2 dpx, vec2 dpy, vec2 k, float fineFade, float clumpFade) {
  return (grassGrain(p, dpx, dpy, k.x) - 0.5) * 0.008 * fineFade + (grassClump(p, dpx, dpy, k.y) - 0.5) * 0.04 * clumpFade;
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
`;

// 替换 map_fragment：diffuseColor 乘以程序生成的地面颜色，groundBumpGrad 记录细节高度沿屏幕 x、y 方向相邻像素的差（米）供法线扰动。
// 高度差用相邻像素位置重新采样得到，而不是对高度求 dFdx：后者在斜看崖壁时按 2×2 像素块跳变，会画出细密的横纹。
const albedoFragment = /* glsl */ `
vec3 groundAlbedo;
vec2 groundBumpGrad;
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
  // 细节完全淡出的远处跳过贴图采样。
  if (clumpFade > 0.0) {
    vec2 k = vec2(groundValueNoise(p * 0.55 + 5.3), groundValueNoise(p * 0.09 + 9.1));
    float grain = grassGrain(p, dpx.xz, dpy.xz, k.x);
    float clump = grassClump(p, dpx.xz, dpy.xz, k.y);
    grass *= (1.0 + (0.8 * clump - 0.4) * clumpFade) * (1.0 + (0.8 * grain - 0.4) * fineFade);
    float h = (grain - 0.5) * 0.008 * fineFade + (clump - 0.5) * 0.04 * clumpFade;
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
  }
#endif
  diffuseColor.rgb *= groundAlbedo;
}
`;

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
}
`;

/**
 * 把地形材质的颜色改为程序地面细节，并让自发光跟随新的颜色；会覆盖材质原有的 onBeforeCompile。
 * @param {THREE.MeshStandardMaterial} material - 带 map 的地形材质，map 是烘焙的反照率贴图，自发光贴图与 map 相同。
 * @param {object} options
 * @param {THREE.Texture} options.detail - `createGroundDetailTexture` 生成的贴图。
 * @param {boolean} options.hasRock - 是否按烘焙贴图的颜色区分岩石，只适用于草地偏绿、岩石偏灰褐、分辨率约 4096 像素的贴图；为 false 时整片按草地绘制，不读取烘焙颜色。
 * @returns {void}
 */
export function applyGroundDetail(material, { detail, hasRock }) {
  if (hasRock) material.defines = { ...material.defines, GROUND_ROCK: '' };
  material.customProgramCacheKey = () => `ground-detail-${hasRock}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGroundDetail = { value: detail };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexPars}`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${vertexMain}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentPars}`)
      .replace('#include <map_fragment>', albedoFragment)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${bumpFragment}`)
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance *= groundAlbedo;');
  };
  material.needsUpdate = true;
}
