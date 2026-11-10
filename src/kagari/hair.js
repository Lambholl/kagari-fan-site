import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, smoothstep, clamp, lerp } from '../util/noise.js';

// 头发在“头部局部坐标”里搭建：原点 = 头部中心，+z = 脸的正面，+y = 头顶。
export const HEAD_R = 0.105;
const HC = new THREE.Vector3(0, 0.012, -0.006); // 发壳中心：比头略靠上靠后，后脑勺更蓬
const HR = 0.121;
const D2R = Math.PI / 180;

/**
 * “发壳”：上半是球面，赤道以下垂直垂落（波波头的轮廓）。
 * theta 为自头顶起算的极角（超过 90° 表示继续向下垂的弧长），phi 自正面转向 +x。
 */
function shell(theta, phi, rOff = 0, flare = 0, out = new THREE.Vector3()) {
  const R = HR + rOff;
  if (theta <= Math.PI / 2) {
    const st = Math.sin(theta);
    return out.set(R * st * Math.sin(phi), R * Math.cos(theta), R * st * Math.cos(phi)).add(HC);
  }
  const k = theta - Math.PI / 2;
  const rr = R * (1 + flare * k * k);
  return out.set(rr * Math.sin(phi), -k * R, rr * Math.cos(phi)).add(HC);
}

// 动画里的发色是带一点粉的淡紫白；月光会再把它染蓝一些
const C_BASE = new THREE.Color(0.86, 0.81, 0.92);
const C_TIP = new THREE.Color(0.74, 0.67, 0.86);
const C_HI = new THREE.Color(0.98, 0.96, 1.0);
const C_UNDER = new THREE.Color(0.56, 0.48, 0.72);
const _c = new THREE.Color();

function hairColor(thetaDeg, t, under, out) {
  out.copy(C_BASE).lerp(C_TIP, smoothstep(0.5, 1.0, t) * 0.85);
  // 发顶偏下的一圈高光（“天使环”）
  const band = Math.exp(-Math.pow((thetaDeg - 46) / 9, 2));
  out.lerp(C_HI, band * 0.6);
  if (under) out.lerp(C_UNDER, 0.75);
  return out;
}

function strandGeometry({ phi, th0 = 3, th1, w, rOff = 0, flare = 0, curl = 0, thick = 0.012, tipOut = 0, tipSharp = 0.5 }) {
  const N = 18;
  const M = 6;
  const centers = [];
  const thetas = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const th = lerp(th0, th1, Math.pow(t, 0.85)) * D2R;
    const ph = phi * D2R + curl * t * t;
    thetas.push(th);
    centers.push(shell(th, ph, rOff + tipOut * t * t * t, flare));
  }
  const pos = [];
  const col = [];
  const idx = [];
  const tangent = new THREE.Vector3();
  const radial = new THREE.Vector3();
  const side = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const c = centers[i];
    tangent.subVectors(centers[Math.min(N, i + 1)], centers[Math.max(0, i - 1)]).normalize();
    const th = thetas[i];
    if (th <= Math.PI / 2) radial.subVectors(c, HC).normalize();
    else radial.set(c.x - HC.x, 0, c.z - HC.z).normalize();
    side.crossVectors(radial, tangent).normalize();
    radial.crossVectors(tangent, side).normalize();
    const converge = clamp(Math.sin(Math.min(th, Math.PI / 2)) / 0.8, 0.1, 1);
    const tp = t < tipSharp ? 1 : Math.pow(Math.max(0, 1 - Math.pow((t - tipSharp) / (1 - tipSharp), 2)), 0.9);
    const wm = w * D2R * HR * converge * tp;
    const tk = thick * (0.35 + 0.65 * tp) * (0.4 + 0.6 * converge);
    for (let j = 0; j < M; j++) {
      const a = (j / M) * Math.PI * 2;
      p.copy(c)
        .addScaledVector(side, (wm / 2) * Math.cos(a))
        .addScaledVector(radial, (tk / 2) * Math.sin(a));
      pos.push(p.x, p.y, p.z);
      hairColor((th / D2R), t, Math.sin(a) < -0.3, _c);
      col.push(_c.r, _c.g, _c.b);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M; j++) {
      const a = i * M + j;
      const b = i * M + ((j + 1) % M);
      const c2 = (i + 1) * M + j;
      const d = (i + 1) * M + ((j + 1) % M);
      idx.push(a, b, c2, b, d, c2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** 贴着头皮的一整层底发，保证发束之间不会漏出头皮 */
function capGeometry() {
  const NP = 72;
  const NT = 16;
  const pos = [];
  const col = [];
  const idx = [];
  const p = new THREE.Vector3();
  for (let i = 0; i <= NP; i++) {
    const phi = (i / NP) * Math.PI * 2;
    let a = Math.abs(((phi / D2R + 180) % 360) - 180); // 0 = 正面, 180 = 后脑
    const thMax = lerp(64, 126, smoothstep(38, 84, a));
    for (let j = 0; j <= NT; j++) {
      const th = (j / NT) * thMax;
      shell(th * D2R, phi, -0.005, -0.12, p);
      pos.push(p.x, p.y, p.z);
      hairColor(th, 0.2 + 0.5 * (j / NT), false, _c);
      _c.multiplyScalar(0.9);
      col.push(_c.r, _c.g, _c.b);
    }
  }
  for (let i = 0; i < NP; i++) {
    for (let j = 0; j < NT; j++) {
      const a = i * (NT + 1) + j;
      const b = (i + 1) * (NT + 1) + j;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** 呆毛：从头顶翘起的一根细发 */
function ahogeGeometry() {
  const top = shell(6 * D2R, 200 * D2R, 0.0);
  const curve = new THREE.QuadraticBezierCurve3(
    top,
    top.clone().add(new THREE.Vector3(-0.012, 0.062, 0.004)),
    top.clone().add(new THREE.Vector3(-0.07, 0.05, 0.035)),
  );
  const N = 14;
  const M = 5;
  const pos = [];
  const col = [];
  const idx = [];
  const tangent = new THREE.Vector3();
  const up = new THREE.Vector3(0, 0, 1);
  const s = new THREE.Vector3();
  const n = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const c = curve.getPoint(t);
    curve.getTangent(t, tangent);
    s.crossVectors(tangent, up).normalize();
    n.crossVectors(s, tangent).normalize();
    const r = 0.0052 * Math.pow(1 - t, 0.7) + 0.0004;
    for (let j = 0; j < M; j++) {
      const a = (j / M) * Math.PI * 2;
      p.copy(c).addScaledVector(s, r * 1.6 * Math.cos(a)).addScaledVector(n, r * Math.sin(a));
      pos.push(p.x, p.y, p.z);
      col.push(C_BASE.r, C_BASE.g, C_BASE.b);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M; j++) {
      const a = i * M + j;
      const b = i * M + ((j + 1) % M);
      const c2 = (i + 1) * M + j;
      const d = (i + 1) * M + ((j + 1) % M);
      idx.push(a, c2, b, b, c2, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** 发饰所在位置（头部局部坐标），side = +1 为她的左侧（+x） */
export function clipAnchor(side, out = new THREE.Vector3()) {
  return shell(96 * D2R, side * 80 * D2R, 0.011, 0.06, out);
}

export function buildHairGeometry() {
  const rand = mulberry32(1203);
  const jit = (v) => (rand() - 0.5) * v;
  const parts = [capGeometry(), ahogeGeometry()];
  const add = (o) => parts.push(strandGeometry(o));

  // 参考成品模型的做法：头发不是一根根细管，而是少数几大片宽而扁、彼此叠压的发束，
  // 每片在末端收成尖，靠描边勾出发束的分界。

  // —— 刘海：盖住眉毛，垂到眼睛上缘；中间一束最长，落在两眼之间 ——
  const bangs = [
    [0, 104, 20, 0.004], [-15, 97, 21, 0.0], [16, 96, 21, 0.0],
    [-30, 93, 20, 0.004], [31, 92, 20, 0.004],
    [-45, 104, 20, 0.0], [46, 106, 20, 0.0],
    [-8, 92, 16, 0.008], [9, 93, 16, 0.008], // 上层：几束短一点的压在外面，做出层次
  ];
  bangs.forEach(([phi, th1, w, rOff]) => {
    add({
      phi: phi + jit(2),
      th1: th1 + jit(3),
      w,
      rOff,
      curl: (phi > 0 ? -1 : 1) * 0.06 + jit(0.05),
      tipSharp: 0.45,
      tipOut: 0.004,
      thick: 0.007,
    });
  });

  // —— 鬓发：顺着脸颊垂到下巴，发梢略向内收 ——
  for (const sgn of [-1, 1]) {
    // 立绘里鬓发垂到项圈附近，下端略向外张开，侧面比脸宽出一圈
    add({ phi: sgn * 58, th1: 140 + jit(3), w: 20, rOff: 0.002, flare: 0.02, curl: -sgn * 0.06, tipSharp: 0.5, thick: 0.008 });
    add({ phi: sgn * 71, th1: 154 + jit(3), w: 24, rOff: 0.006, flare: 0.1, tipOut: 0.01, curl: -sgn * 0.04, tipSharp: 0.55, thick: 0.009 });
    add({ phi: sgn * 86, th1: 150 + jit(3), w: 24, rOff: 0.004, flare: 0.18, tipOut: 0.016, tipSharp: 0.55, thick: 0.009 });
    add({ phi: sgn * 66, th1: 146 + jit(3), w: 9, rOff: 0.009, flare: 0.14, tipOut: 0.014, tipSharp: 0.3, thick: 0.005 });
  }

  // —— 侧后与后脑：齐颈的波波头，发梢微微外翘 ——
  for (let a = 108; a <= 252; a += 16) {
    const fromBack = Math.abs(a - 180) / 72; // 0 = 正后, 1 = 侧面
    add({
      phi: a + jit(3),
      th1: lerp(136, 141, fromBack) + jit(5),
      w: 23,
      rOff: 0.002 + (Math.round(a / 16) % 2) * 0.006,
      flare: lerp(-0.08, 0.12, fromBack),
      tipOut: 0.008 + 0.01 * fromBack,
      curl: jit(0.08),
      tipSharp: 0.6,
      thick: 0.01,
    });
  }
  // 头顶再压一层宽发片，让发旋附近有层次
  for (let a = 0; a < 360; a += 40) {
    add({ phi: a + 14 + jit(8), th1: 66 + jit(10), w: 32, rOff: 0.006, tipSharp: 0.35, thick: 0.006 });
  }

  const geo = mergeGeometries(parts);
  return geo;
}
