import * as THREE from 'three';
import { COLORS, characterToon } from './materials.js';
import { skirtPoint } from './kagari.js';
import { clamp, lerp, smoothstep, damp, makeNoise2D, fbm, mulberry32 } from '../util/noise.js';

// 缎带：平时搭在裙摆与纸面上，有人靠近时浮起，逼近则倒竖化作利刃（在篝局部坐标中计算）。

const UP = new THREE.Vector3(0, 1, 0);
const D2R = Math.PI / 180;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

class Strip {
  constructor(n, material) {
    this.n = n;
    const count = (n + 1) * 2;
    this.pos = new Float32Array(count * 3);
    this.nor = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    const idx = [];
    for (let i = 0; i < n; i++) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setIndex(idx);
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.points = [];
    for (let i = 0; i <= n; i++) this.points.push(new THREE.Vector3());
  }

  setColors(fn) {
    const c = new THREE.Color();
    for (let i = 0; i <= this.n; i++) {
      fn(i / this.n, c);
      this.col.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
    }
    this.geo.attributes.color.needsUpdate = true;
  }

  rebuild(widthFn, twistFn) {
    const { n, points, pos, nor } = this;
    const t = _t;
    const b = _b;
    const b0 = _b0;
    const nr = _n;
    const prev = _prev.set(0, 0, 0);
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      const p = points[i];
      t.subVectors(points[Math.min(n, i + 1)], points[Math.max(0, i - 1)]);
      if (t.lengthSq() < 1e-10) t.set(0, 0, 1);
      t.normalize();
      b0.crossVectors(UP, t);
      if (b0.lengthSq() < 1e-5) b0.copy(prev.lengthSq() > 0 ? prev : _x);
      b0.normalize();
      if (i > 0 && b0.dot(prev) < 0) b0.negate();
      prev.copy(b0);
      const a = twistFn ? twistFn(s) : 0;
      b.copy(b0);
      if (a) {
        nr.crossVectors(t, b0);
        b.multiplyScalar(Math.cos(a)).addScaledVector(nr, Math.sin(a));
      }
      nr.crossVectors(t, b).normalize();
      const w = widthFn(s, i) * 0.5;
      const k = i * 6;
      pos[k] = p.x - b.x * w;
      pos[k + 1] = p.y - b.y * w;
      pos[k + 2] = p.z - b.z * w;
      pos[k + 3] = p.x + b.x * w;
      pos[k + 4] = p.y + b.y * w;
      pos[k + 5] = p.z + b.z * w;
      nor[k] = nor[k + 3] = nr.x;
      nor[k + 1] = nor[k + 4] = nr.y;
      nor[k + 2] = nor[k + 5] = nr.z;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
  }
}
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _b0 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _x = new THREE.Vector3(1, 0, 0);

// 飘动用的不规则波形，取值约 -1 至 1。x 沿缎带随时间平移，波从根部传向末端；y 缓慢推进，波形本身也在变。
// 值噪声叠两层，起伏的间隔和高低随位置和时间随机变化。
const wave = (noise, x, y) => fbm(noise, x, y, 2) * 2 - 1;

function sampleCurve(pts, n) {
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  return curve.getSpacedPoints(n);
}

/** 创建挂在角色节点下的动态缎带组并返回每帧更新函数。 */
export function createRibbons(kagari) {
  const group = new THREE.Group();
  group.name = 'ribbons';
  kagari.group.add(group);

  const ribbonMat = characterToon(0xffffff, 'ribbon', {
    vertexColors: true,
    side: THREE.DoubleSide,
  });

  const WL = kagari.WRIST_REST.L;
  const WR = kagari.WRIST_REST.R;
  const A = COLORS.ribbonA;
  const B = COLORS.ribbonB;
  // 下列控制点以参考腕位 (±0.05, 0.035, 0.37) 标定，手边部分按实际腕位差值平移。
  const shiftL = V(WL.x - 0.05, 0, WL.z - 0.36);
  const shiftR = V(WR.x + 0.045, 0, WR.z - 0.375);
  const nearHand = (side, p, k = 1) => p.addScaledVector(side === 'L' ? shiftL : shiftR, k);

  // —— 连接两只手腕、绕过裙摆的那一长条 ——
  const bridgePts = [WL.clone(), nearHand('L', V(0.17, 0.016, 0.45)), nearHand('L', V(0.36, 0.016, 0.33), 0.5)];
  const sp = new THREE.Vector3();
  for (let deg = 62; deg <= 298; deg += 9) {
    const phi = deg * D2R;
    skirtPoint(phi, 0.74 + 0.1 * Math.sin(phi * 2.3 + 0.5), sp);
    bridgePts.push(V(sp.x, sp.y + 0.014, sp.z));
  }
  bridgePts.push(nearHand('R', V(-0.4, 0.016, 0.3), 0.5), nearHand('R', V(-0.21, 0.016, 0.46)), WR.clone());
  const bridge = {
    strip: new Strip(150, ribbonMat),
    calm: null,
    kind: 'bridge',
    delay: 0.0,
    noise: makeNoise2D(311),
  };
  bridge.calm = sampleCurve(bridgePts, bridge.strip.n);
  // 将曲线采样点钳制到实际裙面高度之上，避免插值中段穿过布面。
  const restOnCloth = (points) => {
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i];
      const y = kagari.clothHeightAt(p.x, p.z);
      if (y !== null) p.y = Math.max(p.y, y + 0.01);
    }
    return points;
  };
  restOnCloth(bridge.calm);
  bridge.strip.setColors((s, c) => c.copy(A).lerp(B, 0.5 - 0.5 * Math.cos(s * Math.PI * 2)));

  // —— 从蝴蝶结垂下来的几条长尾 ——
  const tailDefs = [
    // 平时：短短一截松松地垂在手边，另一条顺着裙摆前缘搭向两侧（照 CG）
    { side: 'L', y: 0.02, pts: [[0.09, 0.45], [0.03, 0.53], [0.1, 0.6]], yaw: 0.35, h: 1.25, len: 1.0, phase: 0.0, delay: 0.1 },
    { side: 'L', y: 0.024, pts: [[0.13, 0.36], [0.25, 0.31], [0.35, 0.22]], yaw: 0.95, h: 0.85, len: 1.25, phase: 2.1, delay: 0.25 },
    { side: 'R', y: 0.028, pts: [[-0.08, 0.47], [-0.15, 0.55], [-0.07, 0.62]], yaw: -0.3, h: 1.45, len: 1.1, phase: 4.0, delay: 0.05 },
    { side: 'R', y: 0.018, pts: [[-0.13, 0.37], [-0.26, 0.31], [-0.36, 0.22]], yaw: -1.0, h: 0.95, len: 1.3, phase: 5.3, delay: 0.3 },
  ];
  // 每条长尾各有一套噪声和节奏（0.8 至 1.25 倍），各自独立摆动。
  const tempoRand = mulberry32(7741);
  const tails = tailDefs.map((d, i) => {
    const w0 = d.side === 'L' ? WL : WR;
    const pts = [w0.clone(), ...d.pts.map(([x, z]) => nearHand(d.side, V(x, d.y, z)))];
    const strip = new Strip(72, ribbonMat);
    strip.setColors((s, c) => c.copy(A).lerp(B, smoothstep(0.0, 0.55, s)).lerp(A, smoothstep(0.7, 1.0, s) * 0.6));
    const noise = makeNoise2D(521 + i * 97);
    const tempo = lerp(0.8, 1.25, tempoRand());
    return { ...d, strip, calm: restOnCloth(sampleCurve(pts, strip.n)), kind: 'tail', rest: w0, noise, tempo };
  });
  // 所有缎带共用的阵风强度，约 0.6 至 1.4 倍，缓慢起伏。
  const gustNoise = makeNoise2D(97);

  for (const r of [bridge, ...tails]) group.add(r.strip.mesh);

  const st = { alert: 0, spike: 0, strike: 0 };
  const wrist = new THREE.Vector3();
  const dirP = new THREE.Vector3();
  const d = new THREE.Vector3();
  const side = new THREE.Vector3();
  const pa = new THREE.Vector3();
  const ps = new THREE.Vector3();
  const off = new THREE.Vector3();
  const target = new THREE.Vector3();

  /**
   * 驱动缎带状态：alert 为 0 到 1 表示浮起程度，spike 为 0 到 1 表示倒竖成刺，
   * strike 为 0 到 1 表示刺向主角的进度，playerLocal 为主角头部在篝局部坐标中的位置。
   */
  function update(dt, time, s) {
    st.alert = damp(st.alert, s.alert, 1.6, dt);
    st.spike = damp(st.spike, s.spike, 5, dt);
    st.strike = s.strike;
    target.copy(s.playerLocal);
    dirP.set(target.x, 0, target.z);
    if (dirP.lengthSq() < 1e-4) dirP.set(0, 0, 1);
    dirP.normalize();
    const gust = 0.6 + 0.8 * fbm(gustNoise, time * 0.25, 0.5, 2);
    // 倒竖成刃时变得僵直，飘动幅度减到四成。
    const flutter = gust * (1 - 0.6 * st.spike);

    // 连接两只手腕的环状缎带
    {
      const { strip, calm, noise } = bridge;
      const a = smoothstep(0, 1, clamp(st.alert * 1.15, 0, 1));
      kagari.wristLocal('L', wrist);
      const dl = off.subVectors(wrist, WL).clone();
      kagari.wristLocal('R', wrist);
      const dr = off.subVectors(wrist, WR).clone();
      for (let i = 0; i <= strip.n; i++) {
        const u = i / strip.n;
        const p = strip.points[i].copy(calm[i]);
        p.addScaledVector(dl, Math.pow(1 - u, 12)).addScaledVector(dr, Math.pow(u, 12));
        if (a > 0.001) {
          const arch = Math.pow(Math.sin(Math.PI * u), 0.8);
          const r = Math.hypot(p.x, p.z) || 1;
          // 三个方向各取一路噪声，沿环向两侧以不同速度传播。
          p.y += a * arch * (0.95 + 0.33 * flutter * wave(noise, u * 1.6 - time * 0.22, 1.7 + time * 0.04));
          p.x += a * arch * ((p.x / r) * 0.22 + 0.16 * flutter * wave(noise, u * 2.9 - time * 0.29, 5.3 + time * 0.05));
          p.z += a * arch * ((p.z / r) * 0.22 + 0.16 * flutter * wave(noise, u * 2.3 + time * 0.26, 9.1 + time * 0.05));
        }
      }
      // 倒竖时收窄绷紧，宽度沿长度连续变化。相邻顶点只隔约 1.5 厘米，逐顶点交替宽窄会连成一格格方块状的锯齿。
      const sp2 = st.spike;
      strip.rebuild(
        () => 0.036 * (1 - 0.4 * sp2),
        (u) => a * 1.4 * flutter * wave(noise, u * 2.9 - time * 0.19, 12.5 + time * 0.03),
      );
    }

    // 从腕结下垂的四条长尾缎带
    for (const r of tails) {
      const { strip, calm, noise } = r;
      const a = smoothstep(0, 1, clamp(st.alert * 1.4 - r.delay, 0, 1));
      kagari.wristLocal(r.side, wrist);
      off.subVectors(wrist, r.rest);
      const tt = time * r.tempo;
      // 整条缎带的慢变化：扬起方向、高度和伸展长度各自缓慢漂移。
      const yaw = r.yaw + 0.35 * wave(noise, tt * 0.13, 11.3);
      const height = r.h * (1 + 0.25 * wave(noise, tt * 0.11, 23.7));
      const reach = r.len * (1 + 0.15 * wave(noise, tt * 0.09, 31.9));
      // 各自朝主角方向偏开一个角度扬起
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      d.set(dirP.x * cy + dirP.z * sy, 0, -dirP.x * sy + dirP.z * cy);
      side.crossVectors(UP, d);
      for (let i = 0; i <= strip.n; i++) {
        const u = i / strip.n;
        const p = strip.points[i].copy(calm[i]).addScaledVector(off, Math.pow(1 - u, 3));
        if (a > 0.001 || st.strike > 0.001) {
          const rise = height * (1 - (1 - u) * (1 - u));
          // 上下与左右各一路噪声，从根部传向末端，越到末端摆得越开。
          const lift = wave(noise, u * 1.4 - tt * 0.42, 3.1 + tt * 0.05);
          const swing = wave(noise, u * 1.8 - tt * 0.55, 7.9 + tt * 0.05);
          pa.copy(wrist)
            .addScaledVector(d, 0.12 * u + 0.8 * u * reach)
            .addScaledVector(UP, 0.02 + rise + 0.2 * flutter * lift * u)
            .addScaledVector(side, 0.33 * flutter * swing * u);
          p.lerp(pa, a);
          if (st.strike > 0.001) {
            ps.copy(wrist).lerp(target, u).addScaledVector(side, Math.sin(u * 9 + r.phase) * 0.06 * (1 - u));
            p.lerp(ps, st.strike);
          }
        }
      }
      // 倒竖化作利刃：根部略宽，向末端平滑收成尖刃，宽度沿长度连续变化。
      const sp2 = st.spike;
      strip.rebuild(
        (u) => lerp(0.034, 0.02, u * u) * lerp(1, 1.4 * Math.pow(1 - u, 0.8), sp2) * (1 - 0.6 * st.strike * u),
        (u) => a * (1 - st.strike) * (u * 5.0 + 1.6 * flutter * wave(noise, u * 1.0 - tt * 0.27, 15.2 + tt * 0.03)),
      );
    }
  }

  return { group, update, state: st };
}
