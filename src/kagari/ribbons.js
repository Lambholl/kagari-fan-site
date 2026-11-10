import * as THREE from 'three';
import { COLORS } from './materials.js';
import { skirtPoint } from './kagari.js';
import { clamp, lerp, smoothstep, damp } from '../util/noise.js';

// 缎带。平时静静搭在裙摆和纸面上；有人靠近时无风自起；
// 进一步逼近则根根倒竖、化作利刃。全部在篝的局部坐标里计算。

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

function sampleCurve(pts, n) {
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  return curve.getSpacedPoints(n);
}

export function createRibbons(kagari) {
  const group = new THREE.Group();
  group.name = 'ribbons';
  kagari.group.add(group);

  const purpleMat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    emissive: 0x000000,
  });
  // 缎带自身带着一点光：在夜里也保持鲜明的紫与洋红
  purpleMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vColor.rgb * 0.5;',
    );
  };
  const blackMat = new THREE.MeshLambertMaterial({
    color: 0x0c0c16,
    side: THREE.DoubleSide,
    emissive: 0x020208,
  });

  const WL = kagari.WRIST_REST.L;
  const WR = kagari.WRIST_REST.R;
  const A = COLORS.ribbonA;
  const B = COLORS.ribbonB;
  // 下面这些落点是照着手腕在 (±0.05, 0.035, 0.37) 时摆的；手腕位置变了，手边的部分跟着平移
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
    strip: new Strip(150, purpleMat),
    calm: null,
    kind: 'bridge',
    phase: 0.7,
    delay: 0.0,
  };
  bridge.calm = sampleCurve(bridgePts, bridge.strip.n);
  bridge.strip.setColors((s, c) => c.copy(A).lerp(B, 0.5 - 0.5 * Math.cos(s * Math.PI * 2)));

  // —— 从蝴蝶结垂下来的几条长尾 ——
  const tailDefs = [
    // 平时：短短一截松松地垂在手边，另一条顺着裙摆前缘搭向两侧（照 CG）
    { side: 'L', y: 0.02, pts: [[0.09, 0.45], [0.03, 0.53], [0.1, 0.6]], yaw: 0.35, h: 1.25, len: 1.0, phase: 0.0, delay: 0.1 },
    { side: 'L', y: 0.024, pts: [[0.13, 0.36], [0.25, 0.31], [0.35, 0.22]], yaw: 0.95, h: 0.85, len: 1.25, phase: 2.1, delay: 0.25 },
    { side: 'R', y: 0.028, pts: [[-0.08, 0.47], [-0.15, 0.55], [-0.07, 0.62]], yaw: -0.3, h: 1.45, len: 1.1, phase: 4.0, delay: 0.05 },
    { side: 'R', y: 0.018, pts: [[-0.13, 0.37], [-0.26, 0.31], [-0.36, 0.22]], yaw: -1.0, h: 0.95, len: 1.3, phase: 5.3, delay: 0.3 },
  ];
  const tails = tailDefs.map((d) => {
    const w0 = d.side === 'L' ? WL : WR;
    const pts = [w0.clone(), ...d.pts.map(([x, z]) => nearHand(d.side, V(x, d.y, z)))];
    const strip = new Strip(72, purpleMat);
    strip.setColors((s, c) => c.copy(A).lerp(B, smoothstep(0.0, 0.55, s)).lerp(A, smoothstep(0.7, 1.0, s) * 0.6));
    return { ...d, strip, calm: sampleCurve(pts, strip.n), kind: 'tail', rest: w0 };
  });

  // —— 从发饰飘出来的黑色细带 ——
  const blackDefs = [
    { side: 'L', len: 0.5, phase: 0.3, out: 0.12 },
    { side: 'L', len: 0.68, phase: 1.9, out: 0.06 },
    { side: 'R', len: 0.55, phase: 3.4, out: 0.11 },
    { side: 'R', len: 0.72, phase: 5.0, out: 0.05 },
  ];
  const blacks = blackDefs.map((d) => ({ ...d, strip: new Strip(48, blackMat), kind: 'black' }));

  for (const r of [bridge, ...tails, ...blacks]) group.add(r.strip.mesh);

  const st = { alert: 0, spike: 0, strike: 0 };
  const wrist = new THREE.Vector3();
  const anchor = new THREE.Vector3();
  const dirP = new THREE.Vector3();
  const d = new THREE.Vector3();
  const side = new THREE.Vector3();
  const pa = new THREE.Vector3();
  const ps = new THREE.Vector3();
  const off = new THREE.Vector3();
  const target = new THREE.Vector3();

  /**
   * @param {object} s
   * @param {number} s.alert  0 = 静静搭着，1 = 全部浮起
   * @param {number} s.spike  0..1 倒竖成刺
   * @param {number} s.strike 0..1 刺向主角
   * @param {THREE.Vector3} s.playerLocal 主角头部（篝的局部坐标）
   */
  function update(dt, time, s) {
    st.alert = damp(st.alert, s.alert, 1.6, dt);
    st.spike = damp(st.spike, s.spike, 5, dt);
    st.strike = s.strike;
    target.copy(s.playerLocal);
    dirP.set(target.x, 0, target.z);
    if (dirP.lengthSq() < 1e-4) dirP.set(0, 0, 1);
    dirP.normalize();

    // 长条
    {
      const { strip, calm } = bridge;
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
          p.y += a * arch * (0.95 + 0.22 * Math.sin(time * 0.7 + u * 5.0));
          p.x += a * arch * ((p.x / r) * 0.22 + 0.1 * Math.sin(time * 0.9 + u * 9.0));
          p.z += a * arch * ((p.z / r) * 0.22 + 0.1 * Math.cos(time * 0.8 + u * 7.0));
        }
      }
      const sp2 = st.spike;
      strip.rebuild(
        (u, i) => 0.036 * (1 + sp2 * (i % 2 ? 1.3 : -0.45)),
        (u) => a * (Math.sin(u * 9 + time * 0.6) * 0.9),
      );
    }

    // 长尾
    for (const r of tails) {
      const { strip, calm } = r;
      const a = smoothstep(0, 1, clamp(st.alert * 1.4 - r.delay, 0, 1));
      kagari.wristLocal(r.side, wrist);
      off.subVectors(wrist, r.rest);
      // 各自朝主角方向偏开一个角度扬起
      const cy = Math.cos(r.yaw);
      const sy = Math.sin(r.yaw);
      d.set(dirP.x * cy + dirP.z * sy, 0, -dirP.x * sy + dirP.z * cy);
      side.crossVectors(UP, d);
      for (let i = 0; i <= strip.n; i++) {
        const u = i / strip.n;
        const p = strip.points[i].copy(calm[i]).addScaledVector(off, Math.pow(1 - u, 3));
        if (a > 0.001 || st.strike > 0.001) {
          const rise = r.h * (1 - (1 - u) * (1 - u));
          pa.copy(wrist)
            .addScaledVector(d, 0.12 * u + 0.8 * u * r.len)
            .addScaledVector(UP, 0.02 + rise + 0.13 * Math.sin(u * 4.0 - time * 1.25 + r.phase * 1.7) * u)
            .addScaledVector(side, Math.sin(u * 5.5 - time * 1.7 + r.phase) * 0.22 * u);
          p.lerp(pa, a);
          if (st.strike > 0.001) {
            ps.copy(wrist).lerp(target, u).addScaledVector(side, Math.sin(u * 9 + r.phase) * 0.06 * (1 - u));
            p.lerp(ps, st.strike);
          }
        }
      }
      const sp2 = st.spike;
      strip.rebuild(
        (u, i) => lerp(0.034, 0.02, u * u) * (1 + sp2 * (i % 2 ? 1.5 : -0.5)) * (1 - 0.6 * st.strike * u),
        (u) => a * (1 - st.strike) * (u * 5.0 + Math.sin(time * 0.8 + u * 3.0 + r.phase)),
      );
    }

    // 黑带：总是轻轻飘在身后
    for (const r of blacks) {
      const { strip } = r;
      const sg = r.side === 'L' ? 1 : -1;
      kagari.clipLocalNow(r.side, anchor);
      const amp = 1 + st.alert * 1.2;
      for (let i = 0; i <= strip.n; i++) {
        const u = i / strip.n;
        const wave = Math.sin(u * 3.4 - time * 0.55 + r.phase);
        const wave2 = Math.sin(u * 5.3 - time * 0.4 + r.phase * 2.0);
        strip.points[i].set(
          anchor.x + sg * (0.02 * u + r.out * u * u) + 0.03 * wave2 * u * amp,
          anchor.y - 0.05 * u - 0.36 * u * u * (1 - 0.5 * st.alert) + 0.04 * wave * u * amp,
          anchor.z - 0.05 * u - r.len * 0.55 * u - 0.02 * wave2 * u,
        );
      }
      strip.rebuild(
        (u) => 0.0135 * (1 - 0.35 * u),
        (u) => u * 2.2 + 0.6 * Math.sin(time * 0.45 + u * 4 + r.phase),
      );
    }
  }

  return { group, update, state: st };
}
