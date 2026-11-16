import * as THREE from 'three';
import { makeNoise2D, fbm, mulberry32, smoothstep } from '../util/noise.js';
import { flowerSurfaceAt } from './terrain.js';
import { isOnPaper } from './paper.js';

const STEM_H = 2.3;
const PAPER_CLEARANCE = 0.25;

/** 一朵雏菊：茎 + 一圈花瓣 + 花心。花盘半径 1 个单位，茎高 STEM_H 个单位。 */
function makeDaisyGeometry(petalColor, centerColor, stemColor) {
  const pos = [];
  const col = [];
  const idx = [];
  const push = (x, y, z, c) => {
    pos.push(x, y, z);
    col.push(c[0], c[1], c[2]);
    return pos.length / 3 - 1;
  };
  // 茎：两片交叉的细长四边形（花盘半径为 1 个单位，茎高 H 个单位）
  const H = STEM_H;
  const sw = 0.09;
  for (let k = 0; k < 2; k++) {
    const dx = k === 0 ? sw : 0;
    const dz = k === 0 ? 0 : sw;
    const a = push(-dx, 0, -dz, stemColor);
    const b = push(dx, 0, dz, stemColor);
    const c2 = push(dx, H, dz, stemColor);
    const d = push(-dx, H, -dz, stemColor);
    idx.push(a, b, c2, a, c2, d);
  }
  const stemVertices = pos.length / 3;
  // 花瓣：微微上翘成浅碗，从侧面看也是一朵花
  const N = 8;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    const half = (Math.PI / N) * 0.86;
    const base = push(Math.cos(a) * 0.14, H, Math.sin(a) * 0.14, petalColor);
    const l = push(Math.cos(a - half) * 0.66, H + 0.16, Math.sin(a - half) * 0.66, petalColor);
    const r = push(Math.cos(a + half) * 0.66, H + 0.16, Math.sin(a + half) * 0.66, petalColor);
    const tip = push(Math.cos(a) * 1.0, H + 0.34, Math.sin(a) * 1.0, petalColor);
    idx.push(base, r, l, l, r, tip);
  }
  // 花心
  const c0 = push(0, H + 0.2, 0, centerColor);
  const M = 5;
  const ring = [];
  for (let k = 0; k < M; k++) {
    const a = (k / M) * Math.PI * 2;
    ring.push(push(Math.cos(a) * 0.27, H + 0.08, Math.sin(a) * 0.27, centerColor));
  }
  for (let k = 0; k < M; k++) idx.push(c0, ring[(k + 1) % M], ring[k]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // 茎比花盘更早小到不足一个像素，需要单独淡出。
  const stems = new Float32Array(pos.length / 3);
  stems.fill(1, 0, stemVertices);
  geo.setAttribute('aStem', new THREE.BufferAttribute(stems, 1));
  // 法线统一朝上：花瓣柔和地“接住”月光，而不是随朝向忽明忽暗
  const nor = new Float32Array(pos.length);
  for (let i = 0; i < nor.length; i += 3) nor[i + 1] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(idx);
  return geo;
}

function makeMaterial(uniforms, distant = false) {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true, side: THREE.DoubleSide, transparent: true,
    depthWrite: !distant, forceSinglePass: true,
  });
  mat.customProgramCacheKey = () => distant ? 'daisy-soft-coverage' : 'daisy-mesh';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    const common = /* glsl */ `
      uniform float uFlowerTime, uFlowerProjection;
      varying float vOpacity;
      varying vec2 vBloom;
    `;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        ${common}
        ${distant ? '' : 'attribute float aStem;'}
      `)
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
          // 用花盘实际占用的像素决定过渡距离，适用于不同窗口和视野。
          vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, ${STEM_H} + 0.12, 0.0, 1.0);
          float radius = length(instanceMatrix[0].xyz);
          float px = radius * uFlowerProjection / max(-center.z, 0.05);
          vec3 up = normalize((modelViewMatrix * vec4(instanceMatrix[1].xyz, 0.0)).xyz);
          float facing = abs(dot(up, center.xyz / max(length(center.xyz), 0.05)));
          vec2 projected = px * vec2(1.0, mix(0.12, 1.0, facing));
          // 整朵花看得见时，单片花瓣仍可能不足一像素。斜看花盘时更晚恢复立体花瓣。
          float readable = min(px, projected.y * 2.7);
          float detail = smoothstep(3.0, 9.0, readable);
          float ph = instanceMatrix[3].x * 0.83 + instanceMatrix[3].z * 1.27;
          float sway = sin(uFlowerTime * 0.9 + ph) * 0.06 + sin(uFlowerTime * 0.37 + ph * 1.7) * 0.05;
          sway *= mix(0.19, 1.0, smoothstep(2.5, 10.5, readable));
          ${distant ? `
          vBloom = position.xy;
          transformed = vec3(0.0, ${STEM_H} + 0.12, 0.0);
          ` : `
          // 茎宽只有花盘半径的约 18%，按茎自己的宽度恢复，避免中景出现跳动的细线。
          float stem = smoothstep(0.75, 1.65, px * 0.18);
          vOpacity = mix(detail, stem, aStem);
          `}
          float bend = transformed.y * transformed.y * 0.6;
          transformed.x += sway * bend;
          transformed.z += sway * 0.6 * bend;
        `,
      )
      .replace('#include <project_vertex>', /* glsl */ `
        #include <project_vertex>
        ${distant ? `
        // 远花用软边花盘表示。扩大到一个可稳定采样的面积，再按原面积减淡。
        vec2 support = max(projected, vec2(1.35));
        mvPosition.xy += vBloom * support * max(-center.z, 0.05) / uFlowerProjection;
        gl_Position = projectionMatrix * mvPosition;
        // 花瓣间有空隙，不能把投影椭圆当作实心花瓣。
        vOpacity = 0.78 * (1.0 - detail) * (projected.x * projected.y) / (support.x * support.y);
        ` : ''}
        if (vOpacity < 0.001 || center.z >= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${common}`)
      .replace('#include <alphatest_fragment>', /* glsl */ `
        diffuseColor.a *= vOpacity;
        ${distant ? 'diffuseColor.a *= 1.0 - smoothstep(0.0, 1.0, dot(vBloom, vBloom));' : ''}
        if (diffuseColor.a < 0.001) discard;
        #include <alphatest_fragment>
      `);
  };
  return mat;
}

function makeDistantBloom(source, uniforms, color) {
  const geo = new THREE.PlaneGeometry(2, 2);
  const normal = geo.getAttribute('normal');
  for (let i = 0; i < normal.count; i++) normal.setXYZ(i, 0, 1, 0);
  geo.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: normal.count }, () => color).flat(), 3));
  const bloom = new THREE.InstancedMesh(geo, makeMaterial(uniforms, true), 0);
  bloom.instanceMatrix = source.instanceMatrix;
  bloom.count = source.count;
  bloom.frustumCulled = false;
  // 先画软边，再叠立体花瓣，以免过渡时软边被前一遍的深度截断。
  bloom.renderOrder = -1;
  return bloom;
}

/** 在台顶平地与缓坡上分布黑白雏菊，远景过渡为软边圆盘以稳定画面亮度。 */
export function createDaisies() {
  const group = new THREE.Group();
  group.name = 'daisies';
  const uniforms = {
    uFlowerTime: { value: 0 },
    uFlowerProjection: { value: 900 },
  };

  const white = makeDaisyGeometry([1.2, 1.22, 1.3], [1.15, 0.86, 0.22], [0.16, 0.32, 0.16]);
  const black = makeDaisyGeometry([0.035, 0.03, 0.06], [0.62, 0.55, 0.78], [0.1, 0.2, 0.12]);
  const MAX = 30000;
  const meshW = new THREE.InstancedMesh(white, makeMaterial(uniforms), MAX);
  const meshB = new THREE.InstancedMesh(black, makeMaterial(uniforms), MAX);

  const rand = mulberry32(8128);
  const nPatch = makeNoise2D(61);
  const nKind = makeNoise2D(62);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  let nw = 0;
  let nb = 0;
  let guard = 0;
  const TOTAL = 46000;
  const RMAX = 110;
  while (nw + nb < TOTAL && guard++ < 900000) {
    // 越靠近丘顶越密
    const r = Math.pow(rand(), 0.66) * RMAX;
    const ang = rand() * Math.PI * 2;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    // 给花瓣、茎的倾斜和摇摆留出空隙，避免纸边的花伸进纸面。
    if (isOnPaper(x, z, PAPER_CLEARANCE)) continue;
    const surface = flowerSurfaceAt(x, z);
    if (!surface) continue;
    const patch = fbm(nPatch, x * 0.11, z * 0.11, 3);
    // 主角上山的南坡开得最盛
    const south = 0.55 + 0.45 * smoothstep(-0.4, 0.5, z / (r + 1e-3));
    const dens = (0.3 + 1.2 * smoothstep(0.34, 0.6, patch)) * (1 - 0.6 * smoothstep(28, RMAX, r)) * south;
    if (rand() > dens) continue;
    // 白与黑成片交错
    const kind = fbm(nKind, x * 0.07 + 40, z * 0.07 - 13, 3) + (rand() - 0.5) * 0.22;
    const isBlack = kind > 0.54;
    const size = 0.04 + rand() * 0.03;
    p.set(x, surface.height + 0.005, z);
    e.set((rand() - 0.5) * 0.6, rand() * Math.PI * 2, (rand() - 0.5) * 0.6);
    q.setFromEuler(e);
    s.set(size, size * (0.75 + rand() * 0.6), size);
    m.compose(p, q, s);
    if (isBlack) {
      if (nb < MAX) meshB.setMatrixAt(nb++, m);
    } else if (nw < MAX) meshW.setMatrixAt(nw++, m);
  }
  meshW.count = nw;
  meshB.count = nb;
  meshW.instanceMatrix.needsUpdate = true;
  meshB.instanceMatrix.needsUpdate = true;
  // 实例遍布整座山，包围球按原点几何算会被误剔除
  meshW.frustumCulled = false;
  meshB.frustumCulled = false;
  const blooms = [
    makeDistantBloom(meshW, uniforms, [1.08, 1.1, 1.19]),
    makeDistantBloom(meshB, uniforms, [0.11, 0.10, 0.16]),
  ];
  group.add(meshW, meshB, ...blooms);

  return {
    group,
    count: nw + nb,
    update(t) {
      uniforms.uFlowerTime.value = t;
    },
    setProjection(pixels) {
      uniforms.uFlowerProjection.value = pixels;
    },
  };
}
