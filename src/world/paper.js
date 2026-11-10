import * as THREE from 'three';
import { mulberry32 } from '../util/noise.js';
import { HILL_TOP } from './terrain.js';
import { MOON_DIR } from './sky.js';

/**
 * 巨大用纸：照着事件 CG，只铺一张。比野餐垫大得多的一整张深蓝色纸。
 * 坐标以篝所在处为原点（世界 xz），rot 为绕 y 轴的旋转。
 * 她坐在纸的正中略偏南的位置，主角从南边上来时，离纸边大约两米。
 */
export const SHEETS = [{ name: 'core', cx: 0.35, cz: -0.85, w: 7.0, h: 6.0, rot: THREE.MathUtils.degToRad(12), core: true }];
const CORE = SHEETS[0];

function toLocal(sheet, x, z, out) {
  const dx = x - sheet.cx;
  const dz = z - sheet.cz;
  const c = Math.cos(sheet.rot);
  const s = Math.sin(sheet.rot);
  out.x = dx * c - dz * s;
  out.y = dx * s + dz * c;
  return out;
}
const _l = { x: 0, y: 0 };

/** 这个世界坐标是否踩在纸上 */
export function isOnPaper(x, z, margin = 0) {
  for (const sh of SHEETS) {
    toLocal(sh, x, z, _l);
    if (Math.abs(_l.x) <= sh.w / 2 + margin && Math.abs(_l.y) <= sh.h / 2 + margin) return true;
  }
  return false;
}

/** 到纸张外缘的近似距离（在纸外为正） */
export function distanceToPaper(x, z) {
  let best = Infinity;
  for (const sh of SHEETS) {
    toLocal(sh, x, z, _l);
    const ox = Math.abs(_l.x) - sh.w / 2;
    const oz = Math.abs(_l.y) - sh.h / 2;
    const d = ox <= 0 && oz <= 0 ? Math.max(ox, oz) : Math.hypot(Math.max(ox, 0), Math.max(oz, 0));
    if (d < best) best = d;
  }
  return best;
}

/** 世界坐标 → 纸面 uv */
function coreUV(x, z) {
  toLocal(CORE, x, z, _l);
  return { u: _l.x / CORE.w + 0.5, v: 0.5 - _l.y / CORE.h };
}

// ————————————————————————————————————————————————————————————
// 生命的理论：一棵写成流程图的大树。
// R = 线条，G = 自根部起算的“流程进度”（用来让光脉冲沿树流动），B = 铺满纸面的数列。
// ————————————————————————————————————————————————————————————
function makeTheoryTexture() {
  const W = 1760;
  const H = 2048;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const rand = mulberry32(4242);

  // —— B：数列 ——
  const glyphs = '0123456789';
  const ops = ['+', '-', '=', '(', ')', '/', ':', '.', '0', '1', '1', '0', 'x', 'n', 'λ', 'Δ', '∑', '∂', '→', '∴'];
  ctx.textBaseline = 'top';
  for (let y = 26; y < H - 26; y += 17) {
    let x = 26 + rand() * 60;
    while (x < W - 40) {
      const len = 3 + ((rand() * 22) | 0);
      let str = '';
      for (let i = 0; i < len; i++) {
        str += rand() < 0.82 ? glyphs[(rand() * 10) | 0] : ops[(rand() * ops.length) | 0];
      }
      const big = rand() < 0.04;
      ctx.font = `${big ? 18 : 12}px "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace`;
      const a = 60 + ((rand() * 150) | 0);
      ctx.fillStyle = `rgb(0,0,${a})`;
      ctx.fillText(str, x, y - (big ? 4 : 0));
      x += ctx.measureText(str).width + 8 + rand() * rand() * 140;
    }
  }

  // —— 树 ——
  const k = coreUV(0, 0);
  const KX = k.u * W;
  const KY = (1 - k.v) * H;
  const ROOT = { x: W * 0.9, y: H * 0.05 };
  const A0 = Math.atan2(KY - ROOT.y, KX - ROOT.x); // 主干走向 ≈ 她面朝的方向
  const segs = [];
  const nodes = [];
  const inBounds = (x, y) => x > 34 && x < W - 34 && y > 34 && y < H - 34;

  function grow(x, y, ang, len, depth, w, dist) {
    let cx = x;
    let cy = y;
    let d = dist;
    const pieces = 2 + ((rand() * 2) | 0);
    for (let p = 0; p < pieces; p++) {
      // 流程图式的折线：角度吸附到 15° 的格子上
      let a = ang + (rand() - 0.5) * 0.7;
      a = A0 + Math.round((a - A0) / (Math.PI / 12)) * (Math.PI / 12);
      const l = (len / pieces) * (0.7 + rand() * 0.6);
      const nx = cx + Math.cos(a) * l;
      const ny = cy + Math.sin(a) * l;
      if (!inBounds(nx, ny)) {
        nodes.push({ x: cx, y: cy, type: 'dead', w, d });
        return;
      }
      segs.push({ x0: cx, y0: cy, x1: nx, y1: ny, w, d0: d, d1: d + l });
      cx = nx;
      cy = ny;
      d += l;
    }
    // 绝大多数枝都很细，没多久就枯了
    const dieP = depth < 2 ? 0 : 0.1 + depth * 0.075;
    if (depth >= 8 || rand() < dieP) {
      nodes.push({ x: cx, y: cy, type: 'dead', w, d });
      return;
    }
    nodes.push({ x: cx, y: cy, type: 'fork', w, d });
    const n = depth < 2 ? 3 : rand() < 0.6 ? 2 : 3;
    const fan = depth < 2 ? 1.25 : 1.0;
    for (let i = 0; i < n; i++) {
      let ca = ang + (i / (n - 1) - 0.5) * fan + (rand() - 0.5) * 0.25;
      ca = Math.max(A0 - 1.35, Math.min(A0 + 1.35, ca));
      grow(cx, cy, ca, len * (0.68 + rand() * 0.24), depth + 1, Math.max(1.2, w * 0.72), d);
    }
  }

  // 主干：最初只有一条流
  {
    let cx = ROOT.x;
    let cy = ROOT.y;
    let d = 0;
    const trunkLen = Math.hypot(KX - ROOT.x, KY - ROOT.y) * 0.56;
    const steps = 9;
    for (let i = 0; i < steps; i++) {
      const a = A0 + (i % 2 ? 1 : -1) * (Math.PI / 12) * (rand() < 0.6 ? 1 : 0);
      const l = trunkLen / steps;
      const nx = cx + Math.cos(a) * l;
      const ny = cy + Math.sin(a) * l;
      segs.push({ x0: cx, y0: cy, x1: nx, y1: ny, w: 9 - i * 0.25, d0: d, d1: d + l });
      cx = nx;
      cy = ny;
      d += l;
      nodes.push({ x: cx, y: cy, type: 'step', w: 8, d });
      // 主干上早早夭折的侧枝
      if (i > 1 && rand() < 0.75) {
        const side = rand() < 0.5 ? 1 : -1;
        grow(cx, cy, A0 + side * (0.7 + rand() * 0.5), 90 + rand() * 80, 5, 2.2, d);
      }
    }
    nodes.push({ x: cx, y: cy, type: 'fork', w: 7, d });
    // 文明诞生：枝条急剧分化成扇形
    const N = 5;
    for (let i = 0; i < N; i++) {
      const ca = A0 + (i / (N - 1) - 0.5) * 2.2;
      grow(cx, cy, ca, 250 + rand() * 90, 1, 5.2, d);
    }
  }

  let maxD = 1;
  for (const s of segs) maxD = Math.max(maxD, s.d1);
  ctx.lineCap = 'round';
  for (const s of segs) {
    const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    const n = Math.max(1, Math.ceil(len / 10));
    for (let i = 0; i < n; i++) {
      const t0 = i / n;
      const t1 = (i + 1) / n;
      const g = Math.round(255 * ((s.d0 + (s.d1 - s.d0) * (t0 + t1) * 0.5) / maxD));
      ctx.strokeStyle = `rgb(255,${g},0)`;
      ctx.lineWidth = s.w;
      ctx.beginPath();
      ctx.moveTo(s.x0 + (s.x1 - s.x0) * t0, s.y0 + (s.y1 - s.y0) * t0);
      ctx.lineTo(s.x0 + (s.x1 - s.x0) * t1, s.y0 + (s.y1 - s.y0) * t1);
      ctx.stroke();
    }
  }
  for (const nd of nodes) {
    const g = Math.round(255 * (nd.d / maxD));
    ctx.strokeStyle = `rgb(255,${g},0)`;
    ctx.fillStyle = `rgb(255,${g},0)`;
    if (nd.type === 'fork') {
      // 判断框：菱形
      const r = 5 + nd.w * 1.5;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(nd.x, nd.y - r);
      ctx.lineTo(nd.x + r, nd.y);
      ctx.lineTo(nd.x, nd.y + r);
      ctx.lineTo(nd.x - r, nd.y);
      ctx.closePath();
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = `rgb(255,${g},0)`;
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (nd.type === 'step') {
      // 处理框：小方块
      ctx.lineWidth = 2;
      ctx.fillStyle = '#000';
      ctx.fillRect(nd.x - 11, nd.y - 7, 22, 14);
      ctx.strokeRect(nd.x - 11, nd.y - 7, 22, 14);
    } else {
      // 枯枝的末端：一个小小的终止符
      const r = 2.5 + nd.w * 0.8;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 16;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/**
 * 纸面的纹理（照着 CG）：密密排列的平行细线，像电路走线，
 * 每条线走一段就斜着错开一格、或断开，再接着往前走。可无缝平铺。
 */
function makeTraceTexture() {
  const S = 1024;
  const GAP = 8; // 线距（像素）
  const LANES = S / GAP;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  const rand = mulberry32(31337);
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';

  // 每段折线在 3×3 的平铺位置各画一遍，保证无缝
  const strokeWrapped = (pts, alpha, width) => {
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.lineWidth = width;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0] + ox * S, pts[0][1] + oy * S);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] + ox * S, pts[i][1] + oy * S);
        ctx.stroke();
      }
    }
  };

  for (let lane = 0; lane < LANES; lane++) {
    const y0 = lane * GAP + GAP / 2;
    let y = y0;
    let x = rand() * S;
    const xEnd = x + S;
    let pts = [[x, y]];
    let alpha = 0.5 + rand() * 0.5;
    while (x < xEnd) {
      const seg = 24 + rand() * rand() * 300;
      x = Math.min(xEnd, x + seg);
      pts.push([x, y]);
      if (x >= xEnd) break;
      const r = rand();
      if (r < 0.42) {
        // 斜着错开一到两格，偏离原位时更倾向于回去
        const off = Math.round((y - y0) / GAP);
        let dir = rand() < 0.5 ? -1 : 1;
        if (off !== 0 && rand() < 0.75) dir = -Math.sign(off);
        const steps = rand() < 0.75 ? 1 : 2;
        const dy = dir * steps * GAP;
        x += Math.abs(dy) * (0.8 + rand() * 0.6);
        y += dy;
        pts.push([x, y]);
      } else if (r < 0.66) {
        // 断开
        strokeWrapped(pts, alpha, 1.5);
        x += 4 + rand() * 26;
        alpha = 0.45 + rand() * 0.55;
        pts = [[x, y]];
      }
    }
    if (pts.length > 1) strokeWrapped(pts, alpha, 1.5);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  return tex;
}

const paperVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const paperFragment = /* glsl */ `
  uniform sampler2D uTrace;
  uniform sampler2D uTheory;
  uniform float uTime;
  uniform float uTheoryAmt;
  uniform float uTile;     // 一块纹理平铺覆盖的米数
  uniform vec2 uSize;
  uniform vec3 uHand;      // xy = 指尖的世界 xz, z = 强度
  uniform vec2 uKagari;    // 篝的世界 xz
  uniform vec2 uShadowDir; // 月影方向（xz，已归一化）
  uniform vec4 uWave;      // xy = 中心, z = 半径, w = 强度
  varying vec2 vUv;
  varying vec3 vWorld;

  void main() {
    vec2 uv = vUv;
    vec2 pm = (uv - 0.5) * uSize; // 纸面上的米制坐标

    float dH = distance(vWorld.xz, uHand.xy);
    float dK = distance(vWorld.xz, uKagari);
    // 她身前那一大片发亮的青色
    float pool = exp(-dH * dH / 1.1);
    float near = exp(-dH * dH / 0.2);
    float tip = exp(-dH * dH / 0.006);
    float far = smoothstep(1.2, 5.0, dK);

    // 底色：深蓝，越远越暗；她手边被照成青色
    vec3 deep = vec3(0.0, 0.02, 0.1);
    vec3 mid = vec3(0.0, 0.06, 0.26);
    vec3 lit = vec3(0.0, 0.32, 0.56);
    vec3 col = mix(mid, deep, far * 0.8);
    col = mix(col, lit, pool * 0.8);

    // 走线。指尖附近的线在被改写：轻轻地抖动
    vec2 jitter = vec2(sin(uTime * 9.0 + pm.y * 90.0), 0.0) * 0.004 * near * uHand.z;
    float tr = texture2D(uTrace, pm / uTile + jitter).r;
    vec3 lineDim = vec3(0.03, 0.22, 0.7);
    vec3 lineLit = vec3(0.3, 0.88, 1.0);
    col += tr * mix(lineDim, lineLit, pool) * (0.42 + 0.45 * pool) * (1.0 - 0.4 * far);

    // 指尖的光
    col += vec3(0.25, 0.8, 1.0) * near * 0.28 * uHand.z;
    col += vec3(0.85, 1.0, 1.0) * tip * 0.9 * uHand.z;

    // 生命的理论：只在凝视纸面时才浮现出来的树形流程图
    if (uTheoryAmt > 0.001) {
      vec4 th = texture2D(uTheory, uv);
      float flow = fract(th.g * 3.0 - uTime * 0.06);
      float pulse = smoothstep(0.88, 1.0, flow);
      col += uTheoryAmt * th.r * vec3(0.3, 0.85, 1.0) * (0.8 + 2.4 * pulse);
      col += uTheoryAmt * th.b * vec3(0.05, 0.4, 0.9) * 0.9;
    }

    // 被“请进来”时掠过纸面的光环
    float dW = distance(vWorld.xz, uWave.xy);
    float dR = (dW - uWave.z) / 0.35;
    col += vec3(0.35, 0.85, 1.0) * exp(-dR * dR) * uWave.w * (0.4 + tr);

    // 她身下的影子：贴地的一团 + 顺着月光拉长的一片
    vec2 rel = vWorld.xz - uKagari;
    float along = dot(rel, uShadowDir);
    float across = dot(rel, vec2(-uShadowDir.y, uShadowDir.x));
    float contact = exp(-dot(rel, rel) / 0.35);
    float sA = max(along - 0.3, 0.0) / 1.1;
    float sB = across / 0.5;
    float moonShade = exp(-(sA * sA + sB * sB)) * step(0.0, along + 0.3);
    col *= 1.0 - 0.45 * contact - 0.3 * moonShade * (1.0 - contact);

    // 纸边被月光勾出一条细亮线
    float edge = min(min(uv.x, 1.0 - uv.x) * uSize.x, min(uv.y, 1.0 - uv.y) * uSize.y);
    col += vec3(0.06, 0.25, 0.5) * (1.0 - smoothstep(0.0, 0.025, edge));

    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createPaper() {
  const group = new THREE.Group();
  group.name = 'paper';
  const trace = makeTraceTexture();
  // 理论图很大，生成稍慢：开场后在空闲时画好，免得剧情里卡一下
  let theory = null;
  setTimeout(() => {
    if (!theory) {
      theory = makeTheoryTexture();
      mat.uniforms.uTheory.value = theory;
    }
  }, 2500);
  const shadowDir = new THREE.Vector2(-MOON_DIR.x, -MOON_DIR.z).normalize();

  const sh = CORE;
  const geo = new THREE.PlaneGeometry(sh.w, sh.h, 48, 40);
  geo.rotateX(-Math.PI / 2);
  // 纸角微微翘起，纸面有一点点起伏
  {
    const pos = geo.attributes.position;
    const rand = mulberry32(100);
    const curl = [rand(), rand(), rand(), rand()].map((v) => 0.04 + v * 0.08);
    for (let j = 0; j < pos.count; j++) {
      const ux = pos.getX(j) / (sh.w / 2);
      const uz = pos.getZ(j) / (sh.h / 2);
      const ci = (ux > 0 ? 1 : 0) + (uz > 0 ? 2 : 0);
      const k = Math.pow(Math.abs(ux * uz), 6);
      const wav = 0.005 * Math.sin(ux * 4.0 + 1.3) * Math.sin(uz * 3.0 + 0.4);
      pos.setY(j, k * curl[ci] + wav + 0.008);
    }
    geo.computeVertexNormals();
  }
  const mat = new THREE.ShaderMaterial({
    vertexShader: paperVertex,
    fragmentShader: paperFragment,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
    uniforms: {
      uTrace: { value: trace },
      uTheory: { value: trace },
      uTime: { value: 0 },
      uTheoryAmt: { value: 0 },
      uTile: { value: 0.95 },
      uSize: { value: new THREE.Vector2(sh.w, sh.h) },
      uHand: { value: new THREE.Vector3(0, 0, 1) },
      uKagari: { value: new THREE.Vector2(0, 0) },
      uShadowDir: { value: shadowDir },
      uWave: { value: new THREE.Vector4(0, 0, 0, 0) },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(sh.cx, HILL_TOP + 0.012, sh.cz);
  mesh.rotation.y = sh.rot;
  group.add(mesh);

  // —— 从纸面浮起的细小光点 ——
  const auraUniforms = { uTime: { value: 0 }, uProj: { value: 900 } };
  const MOTE_N = 220;
  const moteBase = new Float32Array(MOTE_N * 3);
  const moteMisc = new Float32Array(MOTE_N * 3);
  {
    const rand = mulberry32(555);
    let n = 0;
    while (n < MOTE_N) {
      const x = (rand() - 0.5) * 8;
      const z = (rand() - 0.5) * 8 - 0.8;
      if (!isOnPaper(x, z)) continue;
      moteBase.set([x, HILL_TOP, z], n * 3);
      moteMisc.set([rand(), 0.02 + rand() * 0.04, 0.015 + rand() * 0.035], n * 3); // 相位、速度、大小
      n++;
    }
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(moteBase, 3));
  moteGeo.setAttribute('aMisc', new THREE.BufferAttribute(moteMisc, 3));
  const motes = new THREE.Points(
    moteGeo,
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: auraUniforms,
      vertexShader: /* glsl */ `
        attribute vec3 aMisc;
        uniform float uTime;
        uniform float uProj;
        varying float vAlpha;
        void main() {
          float t = fract(aMisc.x + uTime * aMisc.y);
          vec3 p = position;
          p.x += sin(uTime * 0.31 + aMisc.x * 40.0) * 0.25 * t;
          p.z += cos(uTime * 0.27 + aMisc.x * 31.0) * 0.25 * t;
          p.y += 0.03 + t * t * 5.0;
          vAlpha = sin(t * 3.14159) * (1.0 - t * 0.5);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(1.0, aMisc.z * uProj / -mv.z);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = 1.0 - smoothstep(0.0, 0.5, d);
          gl_FragColor = vec4(vec3(0.45, 0.85, 1.0) * 1.3, a * a * vAlpha);
        }
      `,
    }),
  );
  motes.frustumCulled = false;
  motes.renderOrder = 21;
  group.add(motes);

  const wave = { r: 0, strength: 0, active: false };

  return {
    group,
    /** 纸面最上层的高度 */
    surfaceY: HILL_TOP + 0.02,
    /** 屏幕高度（像素）/ (2·tan(fov/2))，用来换算光点的大小 */
    setProjection(v) {
      auraUniforms.uProj.value = v;
    },
    setHand(x, z, strength = 1) {
      mat.uniforms.uHand.value.set(x, z, strength);
    },
    setKagari(x, z) {
      mat.uniforms.uKagari.value.set(x, z);
    },
    /** 0..1：让“生命的理论”浮现到纸面上 */
    setTheory(v) {
      if (v > 0 && !theory) {
        theory = makeTheoryTexture();
        mat.uniforms.uTheory.value = theory;
      }
      mat.uniforms.uTheoryAmt.value = v;
    },
    /** 从篝的位置荡开一圈光 */
    ripple() {
      wave.r = 0;
      wave.strength = 1;
      wave.active = true;
    },
    update(dt, time) {
      auraUniforms.uTime.value = time;
      if (wave.active) {
        wave.r += dt * 3.0;
        wave.strength = Math.max(0, 1 - wave.r / 7);
        if (wave.strength <= 0) wave.active = false;
      }
      mat.uniforms.uTime.value = time;
      mat.uniforms.uWave.value.set(0, 0, wave.r, wave.active ? wave.strength * 1.6 : 0);
    },
  };
}
