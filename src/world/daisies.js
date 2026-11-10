import * as THREE from 'three';
import { makeNoise2D, fbm, mulberry32, smoothstep } from '../util/noise.js';
import { heightAt } from './terrain.js';
import { isOnPaper } from './paper.js';

const STEM_H = 2.3;

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
  // 法线统一朝上：花瓣柔和地“接住”月光，而不是随朝向忽明忽暗
  const nor = new Float32Array(pos.length);
  for (let i = 0; i < nor.length; i += 3) nor[i + 1] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(idx);
  return geo;
}

function makeMaterial(timeUniform) {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        #ifdef USE_INSTANCING
          // 没有风，花却在微微摇晃
          float ph = instanceMatrix[3].x * 0.83 + instanceMatrix[3].z * 1.27;
          float sway = sin(uTime * 0.9 + ph) * 0.06 + sin(uTime * 0.37 + ph * 1.7) * 0.05;
          float bend = transformed.y * transformed.y * 0.6;
          transformed.x += sway * bend;
          transformed.z += sway * 0.6 * bend;
        #endif`,
      );
  };
  return mat;
}

export function createDaisies() {
  const group = new THREE.Group();
  group.name = 'daisies';
  const time = { value: 0 };

  const white = makeDaisyGeometry([1.2, 1.22, 1.3], [1.15, 0.86, 0.22], [0.16, 0.32, 0.16]);
  const black = makeDaisyGeometry([0.035, 0.03, 0.06], [0.62, 0.55, 0.78], [0.1, 0.2, 0.12]);
  const MAX = 30000;
  const meshW = new THREE.InstancedMesh(white, makeMaterial(time), MAX);
  const meshB = new THREE.InstancedMesh(black, makeMaterial(time), MAX);

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
  const RMAX = 60;
  while (nw + nb < TOTAL && guard++ < 900000) {
    // 越靠近丘顶越密
    const r = Math.pow(rand(), 0.66) * RMAX;
    const ang = rand() * Math.PI * 2;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    if (isOnPaper(x, z, -0.12)) continue;
    const patch = fbm(nPatch, x * 0.11, z * 0.11, 3);
    // 主角上山的南坡开得最盛
    const south = 0.55 + 0.45 * smoothstep(-0.4, 0.5, z / (r + 1e-3));
    const dens = (0.3 + 1.2 * smoothstep(0.34, 0.6, patch)) * (1 - 0.6 * smoothstep(28, RMAX, r)) * south;
    if (rand() > dens) continue;
    // 白与黑成片交错
    const kind = fbm(nKind, x * 0.07 + 40, z * 0.07 - 13, 3) + (rand() - 0.5) * 0.22;
    const isBlack = kind > 0.54;
    const size = 0.04 + rand() * 0.03;
    p.set(x, heightAt(x, z) - 0.01, z);
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
  group.add(meshW, meshB);

  return {
    group,
    count: nw + nb,
    update(t) {
      time.value = t;
    },
  };
}
