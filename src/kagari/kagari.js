import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toon, addOutline, COLORS, GRAD_SKIN, GRAD_SOFT, GRAD_CLOTH } from './materials.js';
import { buildHairGeometry, clipAnchor } from './hair.js';
import { smoothstep, lerp, clamp, damp } from '../util/noise.js';

// ————————————————————————————————————————————————————————————
// 篝：身体以「Clannad - Furukawa Nagisa」（Kuroneko Labs，CC-BY-4.0）为底模，
// 去掉原有的头发与衣服（tools/build_base_model.py），在这里用骨骼摆出 FGKG05 的姿势——
// 侧坐在纸上（两膝并在身前，小腿向两侧折到身后），上身前倾，双手按在两膝前的纸上。
// 头发、裙子、泡泡袖、缎带等仍由程序生成，挂在对应的骨骼上。
// 局部坐标：原点 = 骨盆正下方的纸面，+z = 她面朝的方向，+x = 她的左手边。
// ————————————————————————————————————————————————————————————

const D2R = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const MODEL_URL = `${import.meta.env.BASE_URL}models/kagari-base.glb`;

// —— 姿势参数（照 CG：跪坐在脚跟上，两膝略分开，上身前倾，双臂伸直按在两膝之间） ——
const HIP_Y = 0.19; // 骨盆关节离纸面的高度
const HIP_Z = -0.1;
const PELVIS_TILT = 24 * D2R;
const SPINE_BEND = [6, 5, 3, 2].map((d) => d * D2R); // 脊柱各节再往前弯的角度
// 底模的手臂比 CG 里短，按不到纸面：上臂、前臂各拉长一些（动画人物的比例本来就是这样）
const ARM_STRETCH = 1.2;
// 手腕平时按在纸上的位置
const WRIST_REST = { L: V(0.058, 0.036, 0.17), R: V(-0.054, 0.038, 0.185) };

// —— 裙子：在纸面上摊开的布，搭在腿上。几何参数由摆好姿势后的骨骼决定 ——
let WAIST = V(0, 0.2, 0);
let WAIST_R = 0.11;
let HEMC = V(0, 0, 0);
const CAPS = [];

function bodyHeight(x, z) {
  let best = -1;
  for (const c of CAPS) {
    const ax = c.a.x;
    const az = c.a.z;
    const bx = c.b.x - ax;
    const bz = c.b.z - az;
    const l2 = bx * bx + bz * bz;
    const t = l2 > 1e-9 ? clamp(((x - ax) * bx + (z - az) * bz) / l2, 0, 1) : 0;
    const dx = x - (ax + bx * t);
    const dz = z - (az + bz * t);
    const r = lerp(c.ra, c.rb, t);
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      const y = lerp(c.a.y, c.b.y, t) + Math.sqrt(r * r - d2);
      if (y > best) best = y;
    }
  }
  return best;
}

const smoothMax = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
};

/** 裙摆在纸面上铺开的半径：前面刚好盖过膝头，两侧盖住折过去的小腿，身后摊开 */
function hemRadius(phi) {
  const c = Math.cos(phi); // 1 = 正前, -1 = 正后
  const front = 0.27;
  const side = 0.37;
  const back = 0.44;
  let r = side + (c > 0 ? (front - side) * Math.pow(c, 1.6) : (back - side) * Math.pow(-c, 1.3));
  r *= 1 + 0.06 * Math.sin(3 * phi + 0.8) + 0.04 * Math.sin(5 * phi + 2.1) + 0.025 * Math.sin(9 * phi + 4.0);
  return r;
}

/**
 * 裙面上的一点。phi：自正前方转向她左手边的方位角；v：0 = 腰，1 = 裙摆边缘。
 * 裙子从腰间垂下，搭过大腿与膝头，再软软地摊在纸面上。
 */
export function skirtPoint(phi, v, out = new THREE.Vector3()) {
  const e = Math.pow(v, 1.05);
  const R = hemRadius(phi);
  const r = lerp(WAIST_R, R, e);
  const cx = lerp(WAIST.x, HEMC.x, e);
  const cz = lerp(WAIST.z, HEMC.z, e);
  const x = cx + Math.sin(phi) * r;
  const z = cz + Math.cos(phi) * r;
  let y = WAIST.y * Math.pow(1 - v, 1.6);
  // 布料的褶：越往下越明显
  const fold = 0.5 + 0.5 * Math.sin(phi * 9 + 1.8 * Math.sin(phi * 3 + 1.0));
  y += 0.008 + 0.03 * fold * smoothstep(0.2, 0.7, v) * (1 - 0.5 * v);
  const bh = bodyHeight(x, z);
  if (bh > 0) y = smoothMax(y, bh + 0.014, 0.03);
  return out.set(x, Math.max(0.006, y), z);
}

function gridGeometry(NP, NV, fn, wrap = true) {
  const pos = [];
  const idx = [];
  const p = new THREE.Vector3();
  const cols = wrap ? NP : NP + 1;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j <= NV; j++) {
      fn(i / NP, j / NV, p);
      pos.push(p.x, p.y, p.z);
    }
  }
  for (let i = 0; i < NP; i++) {
    const i2 = wrap ? (i + 1) % NP : i + 1;
    for (let j = 0; j < NV; j++) {
      const a = i * (NV + 1) + j;
      const b = i2 * (NV + 1) + j;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function helixBand(y0, y1, r0, r1, turns, width, dirSign, phase) {
  const N = 64;
  const pos = [];
  const nor = [];
  const idx = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const y = lerp(y0, y1, t);
    const r = lerp(r0, r1, t);
    const a = phase + dirSign * turns * Math.PI * 2 * t;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    pos.push(r * cx, y + width / 2, r * cz, r * cx, y - width / 2, r * cz);
    nor.push(cx, 0, cz, cx, 0, cz);
    if (i < N) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  return geo;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();

function quatFromForward(fwd, roll = 0, out = new THREE.Quaternion()) {
  const z = _v1.copy(fwd).normalize();
  const x = _v2.crossVectors(UP, z);
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0);
  x.normalize();
  const y = _v3.crossVectors(z, x);
  _m.makeBasis(x, y, z);
  out.setFromRotationMatrix(_m);
  if (roll) out.multiply(_q1.setFromAxisAngle(_v4.set(0, 0, 1), roll));
  return out;
}

/** 以 dir 为 z、ref（与 dir 正交化后）为 x 的正交基 */
function basisQuat(dir, ref, out) {
  const z = _v1.copy(dir).normalize();
  const x = _v2.copy(ref).addScaledVector(z, -ref.dot(z));
  if (x.lengthSq() < 1e-10) x.set(1, 0, 0).addScaledVector(z, -z.x);
  x.normalize();
  const y = _v3.crossVectors(z, x);
  _m.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_m);
}

/** 两段式 IK：给定肩、目标、两段长度和肘部朝向，求出肘与腕 */
function solveIK(S, T, a, b, pole, elbow, wrist) {
  const d = _v1.subVectors(T, S);
  let L = d.length();
  const dir = d.divideScalar(L || 1);
  L = clamp(L, Math.abs(a - b) + 1e-3, a + b - 1e-4);
  const cosA = clamp((a * a + L * L - b * b) / (2 * a * L), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const p = _v2.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (p.lengthSq() < 1e-8) p.set(0, 0, -1);
  p.normalize();
  elbow.copy(S).addScaledVector(dir, a * cosA).addScaledVector(p, a * sinA);
  wrist.copy(S).addScaledVector(dir, L);
}

// —————————————————————— 底模的材质 ——————————————————————

/** 身体：贴图负责皮肤，顶点属性 aCloth 把躯干涂成连衣裙、腿涂成裤袜 */
function bodyMaterial(map, withCloth) {
  const m = toon(0xffffff, {
    gradient: GRAD_SKIN,
    map,
    emissive: 0xffd2bc,
    emissiveMap: map,
    emissiveIntensity: 0.36,
  });
  if (withCloth) {
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uDress = { value: new THREE.Color(COLORS.dress) };
      sh.uniforms.uTights = { value: new THREE.Color(COLORS.tights) };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aCloth;\nvarying vec2 vCloth;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vCloth = aCloth;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uDress;\nuniform vec3 uTights;\nvarying vec2 vCloth;')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
  diffuseColor.rgb = mix(diffuseColor.rgb, uDress, vCloth.x);
  diffuseColor.rgb = mix(diffuseColor.rgb, uTights, vCloth.y);`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
  float clothW = clamp(vCloth.x + vCloth.y, 0.0, 1.0);
  totalEmissiveRadiance *= 1.0 - clothW;
  totalEmissiveRadiance += uDress * 0.1 * vCloth.x + uTights * 0.12 * vCloth.y;`,
        );
    };
    m.customProgramCacheKey = () => 'kagari-body-cloth';
  }
  return m;
}

/**
 * 按绑定姿势下的位置与蒙皮权重，给身体的每个顶点算出“布料”权重：
 * x = 连衣裙（躯干，留出方领口），y = 裤袜（腿）。
 */
function paintCloth(mesh) {
  const g = mesh.geometry;
  const pos = g.attributes.position;
  const si = g.attributes.skinIndex;
  const sw = g.attributes.skinWeight;
  const bones = mesh.skeleton.bones;
  const kind = bones.map((b) => {
    const n = b.name;
    if (/^DEF-(thigh|shin|foot|toe)/.test(n)) return 'leg';
    if (/^DEF-(upper_arm|forearm|hand|palm|f_|thumb)/.test(n)) return 'arm';
    if (/^DEF-(spine00[56]|jaw|lip|frey)/.test(n)) return 'head';
    if (/^DEF-(spine|pelvis|breast|shoulder)/.test(n)) return 'torso';
    return 'other';
  });
  const cloth = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    let torso = 0;
    let leg = 0;
    let arm = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w <= 0) continue;
      const kd = kind[si.getComponent(i, k)];
      if (kd === 'torso') torso += w;
      else if (kd === 'leg') leg += w;
      else if (kd === 'arm') arm += w;
    }
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(x);
    // 领口：前面是宽而浅的方领，露出锁骨；后面开到肩胛骨上缘；肩头被泡泡袖盖住
    const frontCut = 1.322 - 0.03 * smoothstep(0.05, 0.1, ax);
    const backCut = 1.335;
    const cut = lerp(backCut, frontCut, smoothstep(-0.02, 0.03, z));
    const neckOpen = smoothstep(cut - 0.004, cut + 0.004, y) * (1 - smoothstep(0.1, 0.13, ax));
    // 上臂根部被泡泡袖盖住，那一圈也涂成布
    const armRoot = arm * (1 - smoothstep(0.15, 0.2, ax)) * smoothstep(1.24, 1.28, y);
    let dress = clamp(torso * 1.4, 0, 1) * (1 - neckOpen) + armRoot;
    // 骨盆以下由腿接手：大腿根附近仍然算裙子（反正被裙摆盖住）
    const tights = clamp(leg * 1.3, 0, 1) * smoothstep(0.98, 0.93, y);
    dress = clamp(dress * (1 - tights), 0, 1);
    cloth[i * 2] = dress;
    cloth[i * 2 + 1] = tights;
  }
  g.setAttribute('aCloth', new THREE.BufferAttribute(cloth, 2));
}

/** 睫毛与眉毛共用一张网格：按高度分开上色——眉毛淡紫灰，睫毛深紫 */
function paintBrows(mesh) {
  const pos = mesh.geometry.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const lash = new THREE.Color(0x24162e);
  const brow = new THREE.Color(0xb4aad4);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    c.copy(lash).lerp(brow, smoothstep(1.55, 1.558, pos.getY(i)));
    col.set([c.r, c.g, c.b], i * 3);
  }
  mesh.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

// —————————————————————— 骨骼工具 ——————————————————————

function setupRig(body) {
  const bones = new Map();
  const meshes = new Map();
  let skeleton = null;
  body.traverse((o) => {
    if (o.isBone) bones.set(o.name.replace(/_\d+$/, ''), o);
    if (o.isMesh) meshes.set(o.name, o);
    if (o.isSkinnedMesh && !skeleton) skeleton = o.skeleton;
  });
  const B = (n) => {
    const b = bones.get(n);
    if (!b) throw new Error(`kagari: bone ${n} not found`);
    return b;
  };

  // 回到绑定姿势（模型自带的姿势是在抱东西）
  body.updateMatrixWorld(true);
  const order = skeleton.bones
    .map((b, i) => {
      let d = 0;
      for (let p = b; p.parent; p = p.parent) d++;
      return { b, i, d };
    })
    .sort((a, c) => a.d - c.d);
  const world = new THREE.Matrix4();
  const inv = new THREE.Matrix4();
  for (const { b, i } of order) {
    world.copy(skeleton.boneInverses[i]).invert();
    b.parent.updateWorldMatrix(true, false);
    inv.copy(b.parent.matrixWorld).invert().multiply(world);
    inv.decompose(b.position, b.quaternion, b.scale);
    b.updateMatrixWorld(false);
  }
  body.updateMatrixWorld(true);

  // Rigify 导出后，变形骨（DEF-*）挂在不会动的 ORG / MCH 骨下面。
  // 把它们改挂到对应的 DEF 骨上（attach 保持世界变换），之后只摆 DEF 骨就行。
  const hips = B('DEF-spine');
  const chest = B('DEF-spine003');
  const headBone = B('DEF-spine006');
  for (const n of ['ORG-pelvisL', 'ORG-pelvisR', 'DEF-thighL', 'DEF-thighR']) hips.attach(B(n));
  for (const n of ['ORG-shoulderL', 'ORG-shoulderR', 'ORG-breastL', 'ORG-breastR']) chest.attach(B(n));
  for (const c of [...B('ORG-spine006').children]) headBone.attach(c);
  // 拉长手臂：子骨沿父骨方向挪远，蒙皮会在两骨交界处被均匀拉开
  const bindP = new Map();
  for (const s of ['L', 'R']) {
    for (const n of [`DEF-upper_arm${s}`, `DEF-forearm${s}`, `DEF-hand${s}`]) bindP.set(n, B(n).getWorldPosition(new THREE.Vector3()));
  }
  for (const s of ['L', 'R']) {
    for (const n of [`DEF-upper_arm${s}001`, `DEF-forearm${s}`, `DEF-forearm${s}001`, `DEF-hand${s}`]) {
      B(n).position.multiplyScalar(ARM_STRETCH);
    }
  }
  body.updateMatrixWorld(true);
  return { B, meshes, skeleton, bindP };
}

// —————————————————————— 创建 ——————————————————————

export async function createKagari() {
  const root = new THREE.Group();
  root.name = 'kagari';

  const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  const body = gltf.scene;
  root.add(body);
  const { B, meshes, bindP } = setupRig(body);

  // —— 底模材质 ——
  const atlas = meshes.get('Object_1428').material.emissiveMap;
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;
  // 底模自带的描边网格法线朝内，画正面即可
  const outlineMat = new THREE.MeshBasicMaterial({ color: 0x2a1c30 });
  const mat = {
    body: bodyMaterial(atlas, true),
    face: bodyMaterial(atlas, false),
    eyes: toon(0xffffff, { gradient: GRAD_SOFT, map: atlas, emissive: 0xffffff, emissiveMap: atlas, emissiveIntensity: 0.3, side: THREE.DoubleSide }),
    eyeWhite: toon(0xf4f2fa, { gradient: GRAD_SOFT, emissive: 0x8c8aa0 }),
    brows: toon(0xffffff, { gradient: GRAD_SOFT, vertexColors: true, emissive: 0x0c0810 }),
    tights: toon(COLORS.tights, { gradient: GRAD_CLOTH, emissive: 0x03070a }),
    hair: toon(0xffffff, { gradient: GRAD_SOFT, vertexColors: true, side: THREE.DoubleSide, emissive: 0x14142a }),
    dress: toon(COLORS.dress, { gradient: GRAD_CLOTH, side: THREE.DoubleSide, emissive: 0x05080e }),
    frill: toon(COLORS.frill, { gradient: GRAD_SOFT, side: THREE.DoubleSide, emissive: 0x10141c }),
    black: toon(COLORS.black, { gradient: GRAD_CLOTH, side: THREE.DoubleSide }),
    wrap: toon(0x8a48e0, { gradient: GRAD_SOFT, side: THREE.DoubleSide, emissive: 0x1c0a34 }),
  };
  const bodyMesh = meshes.get('Object_1428');
  paintCloth(bodyMesh);
  bodyMesh.material = mat.body;
  meshes.get('Object_1429').material = mat.tights;
  meshes.get('Object_1434').material = mat.face;
  meshes.get('Object_1437').material = mat.eyes;
  // 眼白是向外鼓的球面，比瞳孔片还靠前：先画、不写深度，瞳孔就能盖在上面
  meshes.get('Object_1440').material = mat.eyeWhite;
  mat.eyeWhite.depthWrite = false;
  meshes.get('Object_1440').renderOrder = -1;
  paintBrows(meshes.get('Object_1432'));
  meshes.get('Object_1432').material = mat.brows;
  // 描边先画：透过眼眶看到的头壳内侧随后会被眼白盖住
  for (const n of ['Object_1430', 'Object_1435']) {
    meshes.get(n).material = outlineMat;
    meshes.get(n).renderOrder = -2;
  }
  body.traverse((o) => {
    if (o.isMesh) {
      o.frustumCulled = false;
      o.raycast = () => {};
    }
  });

  // —— 绑定姿势下的参考量（此时 root 是单位变换，世界 = 局部） ——
  const restQ = new Map();
  const restP = new Map();
  const remember = (b) => {
    restQ.set(b, b.getWorldQuaternion(new THREE.Quaternion()));
    restP.set(b, b.getWorldPosition(new THREE.Vector3()));
  };
  const bn = {
    hips: B('DEF-spine'),
    spine: [B('DEF-spine001'), B('DEF-spine002'), B('DEF-spine003'), B('DEF-spine004')],
    neck: B('DEF-spine005'),
    head: B('DEF-spine006'),
    eye: { L: B('DEF-freyeL'), R: B('DEF-freyeR') },
  };
  for (const s of ['L', 'R']) {
    bn[s] = {
      thigh: B(`DEF-thigh${s}`),
      thigh1: B(`DEF-thigh${s}001`),
      shin: B(`DEF-shin${s}`),
      shin1: B(`DEF-shin${s}001`),
      foot: B(`DEF-foot${s}`),
      toe: B(`DEF-toe${s}`),
      upper: B(`DEF-upper_arm${s}`),
      upper1: B(`DEF-upper_arm${s}001`),
      fore: B(`DEF-forearm${s}`),
      fore1: B(`DEF-forearm${s}001`),
      hand: B(`DEF-hand${s}`),
      index: [B(`DEF-f_index01${s}`), B(`DEF-f_index02${s}`), B(`DEF-f_index03${s}`)],
      middle: [B(`DEF-f_middle01${s}`), B(`DEF-f_middle02${s}`), B(`DEF-f_middle03${s}`)],
      ring: [B(`DEF-f_ring01${s}`), B(`DEF-f_ring02${s}`), B(`DEF-f_ring03${s}`)],
      pinky: [B(`DEF-f_pinky01${s}`), B(`DEF-f_pinky02${s}`), B(`DEF-f_pinky03${s}`)],
      thumb: [B(`DEF-thumb01${s}`), B(`DEF-thumb02${s}`), B(`DEF-thumb03${s}`)],
    };
  }
  body.traverse((o) => {
    if (o.isBone) remember(o);
  });
  const RP = (b) => restP.get(b);
  const RQ = (b) => restQ.get(b);
  // 头的中心（球心）与正面：由眼睛和头骨的位置推出来
  const eyeMid = RP(bn.eye.L).clone().add(RP(bn.eye.R)).multiplyScalar(0.5);
  const HEAD_CENTER_REST = V(0, eyeMid.y + 0.022, RP(bn.head).z + 0.012);

  // 每段肢体在绑定姿势下的“方向 + 参考轴”基
  const restBasisInv = new Map();
  const setRestBasis = (b, dir, ref) => restBasisInv.set(b, basisQuat(dir, ref, new THREE.Quaternion()).invert());
  const Z = V(0, 0, 1);
  for (const s of ['L', 'R']) {
    const L = bn[s];
    const tDir = RP(L.shin).clone().sub(RP(L.thigh));
    setRestBasis(L.thigh, tDir, Z);
    setRestBasis(L.shin, RP(L.foot).clone().sub(RP(L.shin)), Z);
    setRestBasis(L.foot, RP(L.toe).clone().sub(RP(L.foot)), UP);
    const u = RP(L.fore).clone().sub(RP(L.upper));
    const f = RP(L.hand).clone().sub(RP(L.fore));
    setRestBasis(L.upper, u, u.clone().cross(Z));
    setRestBasis(L.fore, f, f.clone().cross(Z));
    setRestBasis(L.hand, RP(L.middle[0]).clone().sub(RP(L.hand)), RP(L.pinky[0]).clone().sub(RP(L.index[0])));
    L.len = { thigh: tDir.length(), shin: RP(L.foot).distanceTo(RP(L.shin)), upper: u.length(), fore: f.length() };
  }

  // —— 在 root 坐标系里设置骨骼的朝向 ——
  const qInRoot = (obj, out) => {
    out.identity();
    for (let p = obj; p && p !== root; p = p.parent) out.premultiply(p.quaternion);
    return out;
  };
  const setQ = (b, q) => {
    qInRoot(b.parent, _q3).invert();
    b.quaternion.copy(_q3).multiply(q);
  };
  /** 骨骼世界朝向 = delta · 绑定朝向 */
  const setDelta = (b, delta) => setQ(b, _q2.copy(delta).multiply(RQ(b)));
  const deltaFromBasis = (b, dir, ref, out) => basisQuat(dir, ref, out).multiply(restBasisInv.get(b));
  const posInRoot = (b, out) => {
    b.updateWorldMatrix(true, false);
    return root.worldToLocal(b.getWorldPosition(out));
  };

  // —————————— 1. 躯干 ——————————
  const torsoDelta = [];
  {
    const parentM = new THREE.Matrix4();
    bn.hips.parent.updateWorldMatrix(true, false);
    parentM.copy(root.matrixWorld).invert().multiply(bn.hips.parent.matrixWorld).invert();
    bn.hips.position.copy(V(0, HIP_Y, HIP_Z).applyMatrix4(parentM));
    let a = PELVIS_TILT;
    const dHips = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), a);
    setDelta(bn.hips, dHips);
    bn.spine.forEach((b, i) => {
      a += SPINE_BEND[i];
      const d = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), a);
      torsoDelta.push(d);
      setDelta(b, d);
    });
  }
  const chestDelta = torsoDelta[3];

  // —————————— 2. 腿：跪坐（大腿向前，膝头略分开，小腿折回压在身下） ——————————
  const legCaps = [];
  for (const s of ['L', 'R']) {
    const sg = s === 'L' ? 1 : -1;
    const L = bn[s];
    const T = posInRoot(L.thigh, new THREE.Vector3());
    const kx = sg * 0.1 - T.x;
    const ky = 0.062 - T.y;
    const kz = Math.sqrt(Math.max(0.01, L.len.thigh ** 2 - kx * kx - ky * ky));
    const t = V(kx, ky, kz).normalize();
    // 膝盖朝前上方，稍向内扣：小腿折回时脚跟落在臀下、略向外
    const tilt = 8 * D2R;
    const k = V(-sg * Math.sin(tilt), Math.cos(tilt), 0);
    k.addScaledVector(t, -k.dot(t)).normalize();
    const dThigh = deltaFromBasis(L.thigh, t, k, new THREE.Quaternion());
    setDelta(L.thigh, dThigh);
    setDelta(L.thigh1, dThigh);
    const fold = 166 * D2R;
    const sd = t.clone().multiplyScalar(Math.cos(fold)).addScaledVector(k, -Math.sin(fold)).normalize();
    const sf = k.clone().multiplyScalar(Math.cos(fold)).addScaledVector(t, Math.sin(fold)).normalize();
    const dShin = deltaFromBasis(L.shin, sd, sf, new THREE.Quaternion());
    setDelta(L.shin, dShin);
    setDelta(L.shin1, dShin);
    // 脚背贴着纸，脚尖顺着小腿伸直
    const fd = sd.clone().addScaledVector(sf, 0.1).normalize();
    const dFoot = deltaFromBasis(L.foot, fd, sf, new THREE.Quaternion());
    setDelta(L.foot, dFoot);
    setDelta(L.toe, dFoot);
    const K = posInRoot(L.shin, new THREE.Vector3());
    const A = posInRoot(L.foot, new THREE.Vector3());
    const Tt = posInRoot(L.toe, new THREE.Vector3());
    legCaps.push({ a: T.clone(), b: K.clone(), ra: 0.075, rb: 0.052 });
    legCaps.push({ a: K.clone(), b: A.clone(), ra: 0.048, rb: 0.034 });
    legCaps.push({ a: A.clone(), b: Tt.clone(), ra: 0.034, rb: 0.026 });
  }
  CAPS.length = 0;
  CAPS.push(...legCaps);
  const hipsP = posInRoot(bn.hips, new THREE.Vector3());
  CAPS.push({ a: V(0, 0.09, hipsP.z - 0.03), b: V(0, 0.09, hipsP.z - 0.031), ra: 0.13, rb: 0.13 });
  // 腰线：绑定姿势里腰最细处，跟着骨盆的倾斜一起转
  {
    const waistRest = V(0, 1.09, -0.01);
    const off = waistRest.sub(RP(bn.spine[0])).applyQuaternion(torsoDelta[0]);
    WAIST = posInRoot(bn.spine[0], new THREE.Vector3()).add(off);
    WAIST_R = 0.095;
    HEMC = V(0, 0, hipsP.z + 0.05);
  }

  // —————————— 3. 程序生成的衣物与头发 ——————————
  // 裙子
  const skirt = new THREE.Mesh(gridGeometry(144, 32, (u, v, p) => skirtPoint(u * Math.PI * 2, v, p)), mat.dress);
  addOutline(skirt, 0.003);
  root.add(skirt);
  const hem = new THREE.Vector3();
  const frillFn = (width, amp, freq, phase) => (u, k, p) => {
    const phi = u * Math.PI * 2;
    skirtPoint(phi, 1, hem);
    const ox = Math.sin(phi);
    const oz = Math.cos(phi);
    const ruffle = Math.sin(phi * freq + phase);
    const out = width * k * (1 + 0.25 * ruffle);
    const y = lerp(hem.y - 0.006, 0.006, Math.pow(k, 0.6)) + amp * Math.sin(k * Math.PI) * (0.5 + 0.5 * ruffle);
    p.set(hem.x + ox * out, Math.max(0.005, y), hem.z + oz * out);
  };
  const frillA = new THREE.Mesh(gridGeometry(288, 4, frillFn(0.04, 0.012, 52, 0)), mat.frill);
  const frillB = new THREE.Mesh(gridGeometry(288, 4, frillFn(0.065, 0.008, 41, 1.7)), mat.frill);
  frillB.position.y = -0.002;
  addOutline(frillA, 0.0018);
  root.add(frillA, frillB);

  /** 挂在骨骼上的“绑定姿势坐标系”：子物体按绑定姿势（站立、面朝 +z）的局部坐标摆放 */
  const restFrame = (bone, origin) => {
    const f = new THREE.Group();
    bone.add(f);
    f.quaternion.copy(RQ(bone)).invert();
    f.position.copy(origin).sub(RP(bone)).applyQuaternion(f.quaternion);
    return f;
  };
  /** 以骨骼方向为 +y 的坐标系（袖子、缎带用），原点在 from */
  const segmentFrame = (bone, from, to, sideHint) => {
    const f = restFrame(bone, from);
    const dir = to.clone().sub(from).normalize();
    const zq = basisQuat(dir, V(sideHint, 0, 0), new THREE.Quaternion());
    f.quaternion.multiply(zq).multiply(_q1.setFromAxisAngle(V(1, 0, 0), Math.PI / 2));
    return f;
  };

  // 头发：程序生成的波波头（按 hair.js 的头部尺寸缩放到底模的头上）
  const head = restFrame(bn.head, HEAD_CENTER_REST);
  const hairScale = 1.0;
  const hair = new THREE.Mesh(buildHairGeometry(), mat.hair);
  hair.scale.setScalar(hairScale);
  hair.position.set(0, 0, -0.004);
  addOutline(hair, 0.0014, 0x3a3052);
  head.add(hair);
  // 阶梯状的黑色发夹，左右各一
  const clipLocal = { L: clipAnchor(1).multiplyScalar(hairScale).add(hair.position), R: clipAnchor(-1).multiplyScalar(hairScale).add(hair.position) };
  const clips = {};
  for (const s of [1, -1]) {
    const g = mergeGeometries([
      new THREE.BoxGeometry(0.011, 0.05, 0.018).translate(0, 0, 0.01),
      new THREE.BoxGeometry(0.011, 0.037, 0.016).translate(0, 0.004, -0.006),
      new THREE.BoxGeometry(0.011, 0.023, 0.014).translate(0, 0.008, -0.02),
    ]);
    const clip = new THREE.Mesh(g, mat.black);
    clip.position.copy(s > 0 ? clipLocal.L : clipLocal.R);
    clip.rotation.set(0.15, s * 8 * D2R, 0);
    addOutline(clip, 0.0012, 0x000000);
    head.add(clip);
    clips[s > 0 ? 'L' : 'R'] = clip;
  }

  // 项圈与两条交叉拉到领口的细带
  {
    const neckRest = RP(bn.neck).clone().lerp(RP(bn.head), 0.35);
    const neckF = restFrame(bn.neck, neckRest);
    const choker = new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.0055, 8, 32), mat.black);
    choker.scale.set(1, 1.15, 1);
    choker.rotation.x = Math.PI / 2 + 0.22;
    neckF.add(choker);
    const chestF = restFrame(bn.spine[3], V(0, 0, 0));
    const strap = (x0, y0, z0, x1, y1, z1) => {
      const a = V(x0, y0, z0);
      const b = V(x1, y1, z1);
      const len = a.distanceTo(b);
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.006, len, 0.002), mat.black);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
      chestF.add(m);
    };
    strap(-0.068, 1.318, 0.06, 0.02, 1.4, 0.03);
    strap(0.068, 1.318, 0.06, -0.02, 1.4, 0.03);
  }

  // 手臂上的泡泡袖、袖口荷叶边、前臂的交叉缎带和腕上的蝴蝶结
  const armRadius = (from, to, boneFilter) => {
    // 量一下底模手臂的粗细（绑定姿势下离骨轴的平均距离）
    const g = bodyMesh.geometry;
    const pos = g.attributes.position;
    const si = g.attributes.skinIndex;
    const sw = g.attributes.skinWeight;
    const bones = bodyMesh.skeleton.bones;
    const axis = to.clone().sub(from);
    const L = axis.length();
    axis.normalize();
    const p = new THREE.Vector3();
    const near = [];
    const far = [];
    for (let i = 0; i < pos.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (boneFilter.has(bones[si.getComponent(i, k)])) w += sw.getComponent(i, k);
      if (w < 0.8) continue;
      p.fromBufferAttribute(pos, i).sub(from);
      const t = p.dot(axis) / L;
      const r = p.addScaledVector(axis, -p.dot(axis)).length();
      if (t > 0.15 && t < 0.35) near.push(r);
      if (t > 0.7 && t < 0.9) far.push(r);
    }
    const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    return [avg(near), avg(far)];
  };
  for (const s of ['L', 'R']) {
    const sg = s === 'L' ? 1 : -1;
    const L = bn[s];
    // 粗细在拉长之前的绑定网格上量
    const bp = (n) => bindP.get(`DEF-${n}${s}`);
    const [ur0, ur1] = armRadius(bp('upper_arm'), bp('forearm'), new Set([L.upper, L.upper1]));
    const [fr0, fr1] = armRadius(bp('forearm'), bp('hand'), new Set([L.fore, L.fore1]));
    L.radius = { ur0, ur1, fr0, fr1 };
    const upperF = segmentFrame(L.upper, RP(L.upper), RP(L.fore), sg);
    const puff = new THREE.Mesh(new THREE.SphereGeometry(ur0 + 0.024, 20, 14), mat.dress);
    puff.scale.set(1.08, 1.12, 1.05);
    puff.position.set(0, 0.024, 0);
    addOutline(puff, 0.0028);
    upperF.add(puff);
    const cuffY = 0.05;
    const cuff = new THREE.Mesh(
      gridGeometry(96, 4, (u, k, p) => {
        const a = u * Math.PI * 2;
        const ruffle = Math.sin(a * 14);
        const r = lerp(ur0 + 0.006, ur0 + 0.024 + 0.006 * ruffle, Math.sqrt(k));
        p.set(Math.cos(a) * r, lerp(cuffY, cuffY + 0.018 + 0.005 * ruffle, k), -Math.sin(a) * r);
      }),
      mat.frill,
    );
    addOutline(cuff, 0.0016);
    upperF.add(cuff);

    const foreLen = L.len.fore;
    const foreF = segmentFrame(L.fore, RP(L.fore), RP(L.hand), sg);
    const rAt = (y) => lerp(fr0, fr1, clamp(y / foreLen, 0, 1)) + 0.0022;
    const y0 = 0.04;
    const y1 = foreLen - 0.01;
    const wrapGeo = mergeGeometries(
      [
        helixBand(y0, y1, rAt(y0), rAt(y1), 2.2, 0.016, 1, 0),
        helixBand(y0, y1, rAt(y0), rAt(y1), 2.2, 0.016, -1, 1.2),
        new THREE.CylinderGeometry(rAt(y1) + 0.0004, rAt(y1) + 0.0006, 0.018, 16, 1, true).translate(0, y1, 0),
      ].map((g) => {
        const n = g.index ? g.toNonIndexed() : g;
        if (n.attributes.uv) n.deleteAttribute('uv');
        if (!n.attributes.normal) n.computeVertexNormals();
        return n;
      }),
    );
    // 前臂的缎带跟着扭转骨走，免得手腕一转就和皮肤错开
    const fore1F = segmentFrame(L.fore1, RP(L.fore), RP(L.hand), sg);
    fore1F.add(new THREE.Mesh(wrapGeo, mat.wrap));
    const bow = new THREE.Group();
    const loopGeo = new THREE.TorusGeometry(0.016, 0.0055, 6, 16).scale(1, 0.6, 2.0);
    for (const ls of [1, -1]) {
      const loop = new THREE.Mesh(loopGeo, mat.wrap);
      loop.position.set(0, ls * 0.016, 0);
      loop.rotation.set(0, 0, Math.PI / 2 + ls * 0.25);
      bow.add(loop);
    }
    bow.add(new THREE.Mesh(new THREE.SphereGeometry(0.007, 10, 8), mat.wrap));
    bow.position.set(sg * (rAt(y1) + 0.004), y1 - 0.004, 0);
    bow.rotation.set(0, 0, Math.PI / 2);
    fore1F.add(bow);
    L.frames = { upperF, foreF, fore1F };
  }

  // —————————— 4. 表情：眼睑与嘴角 ——————————
  // 上眼睑骨沿着头的 -y 方向下移即可闭眼；嘴角骨上移就是微笑。
  // 位移量预先换算成各骨骼父坐标系里的向量（头怎么转都不变）
  // 眼睑（皮肤）和睫毛（单独的网格）各有一串骨骼，要一起动。
  // 它们的父骨带着 0.01 的缩放（局部单位是厘米），位移要换算回去
  const localDir = (b, v) => v.applyQuaternion(RQ(b.parent).clone().invert()).divideScalar(b.parent.getWorldScale(_v1).x);
  const lidBones = [];
  body.traverse((b) => {
    const m = b.isBone && /^DEF-frey(elid|elashes)\d{3}([LR])_\d+$/.exec(b.name);
    if (!m) return;
    const eye = RP(bn.eye[m[2]]);
    // 中间动得多，眼角少
    const dx = (RP(b).x - eye.x) / 0.034;
    const w = clamp(1 - dx * dx, 0.25, 1);
    lidBones.push({ b, w, rest: b.position.clone(), dir: localDir(b, V(0, -1, 0.12)) });
  });
  const mouthBones = [];
  for (const n of ['DEF-lip2TL', 'DEF-lip2BL', 'DEF-lip2TR', 'DEF-lip2BR']) {
    const b = B(n);
    mouthBones.push({ b, rest: b.position.clone(), dir: localDir(b, V(0, 1, -0.2)) });
  }
  const EXPR = {
    neutral: { lid: 0.004, mouth: 0 },
    stare: { lid: -0.001, mouth: 0 },
    smile: { lid: 0.012, mouth: 0.0025 },
  };

  // ————————————————————— 动画状态 —————————————————————
  const state = {
    look: 0, // 0 = 看着图纸；1 = 抬头看主角
    lookTarget: 0,
    lookSpeed: 3.2,
    tracing: 1, // 指尖描画的活跃度（停滞时降到 0）
    tracingTarget: 1,
    traceT: 0,
    reach: { L: { w: 0, target: 0, to: V(0, 0.5, 1) }, R: { w: 0, target: 0, to: V(0, 0.5, 1) } },
    expression: 'neutral',
    expr: { ...EXPR.neutral },
    canSee: false,
    blink: 0,
    nextBlink: 2.5,
  };

  const shoulder = { L: posInRoot(bn.L.upper, new THREE.Vector3()), R: posInRoot(bn.R.upper, new THREE.Vector3()) };
  const HEAD_C = new THREE.Vector3();
  head.updateWorldMatrix(true, false);
  root.worldToLocal(head.getWorldPosition(HEAD_C));

  // 看图纸时的头部姿态：低着头看手边，略偏向描画的那只手
  const WORK_PITCH = 30 * D2R;
  const WORK_YAW = -8 * D2R;
  const qWork = quatFromForward(
    V(Math.sin(WORK_YAW) * Math.cos(WORK_PITCH), -Math.sin(WORK_PITCH), Math.cos(WORK_YAW) * Math.cos(WORK_PITCH)),
    -0.08,
    new THREE.Quaternion(),
  );
  const qLook = new THREE.Quaternion();
  const qHead = new THREE.Quaternion();
  const qNeck = new THREE.Quaternion();
  const qEye = new THREE.Quaternion();
  const wristTarget = { L: WRIST_REST.L.clone(), R: WRIST_REST.R.clone() };
  const dir = new THREE.Vector3();
  const camLocal = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const pole = new THREE.Vector3();
  const elbow = new THREE.Vector3();
  const wrist = new THREE.Vector3();
  const segU = new THREE.Vector3();
  const segF = new THREE.Vector3();
  const hinge = new THREE.Vector3();
  const fingers = new THREE.Vector3();
  const across = new THREE.Vector3();
  const dUpper = new THREE.Quaternion();
  const dFore = new THREE.Quaternion();
  const dHand = new THREE.Quaternion();
  const dTwist = new THREE.Quaternion();

  function poseArm(s, target, w) {
    const sg = s === 'L' ? 1 : -1;
    const L = bn[s];
    // 肘尖朝外、朝后
    pole.set(sg * 0.75, -0.1, -1).normalize();
    solveIK(shoulder[s], target, L.len.upper, L.len.fore, pole, elbow, wrist);
    segU.subVectors(elbow, shoulder[s]);
    segF.subVectors(wrist, elbow);
    hinge.crossVectors(segU, segF);
    if (hinge.lengthSq() < 1e-8) hinge.set(-1, 0, 0);
    deltaFromBasis(L.upper, segU, hinge, dUpper);
    deltaFromBasis(L.fore, segF, hinge, dFore);
    setDelta(L.upper, dUpper);
    setDelta(L.upper1, dUpper);
    setDelta(L.fore, dFore);
    // 手：平放时手指朝前略向内、指尖微微压向纸面；伸出时掌心朝上
    const fd = _v4.copy(segF).normalize();
    fingers.set(fd.x * 0.5 - sg * 0.12, 0, fd.z * 0.5 + 0.9).normalize();
    fingers.y = -0.3;
    fingers.normalize();
    across.crossVectors(UP, fingers).normalize().multiplyScalar(sg);
    across.y -= 0.12 * sg;
    deltaFromBasis(L.hand, fingers, across, dHand);
    if (w > 0.001) {
      // 伸出的手：手指顺着前臂，掌心朝上
      across.crossVectors(UP, fd).normalize().multiplyScalar(-sg);
      deltaFromBasis(L.hand, _v4.copy(fd).setY(fd.y * 0.4), across, _q1);
      dHand.slerp(_q1, w);
    }
    dTwist.copy(dFore).slerp(dHand, 0.5);
    setDelta(L.fore1, dTwist);
    setDelta(L.hand, dHand);
  }

  /** 手指：右手伸出食指描画，其余收拢；左手自然地微微弯着 */
  function poseFingers() {
    for (const s of ['L', 'R']) {
      const L = bn[s];
      L.hand.updateWorldMatrix(true, false);
      const handQ = qInRoot(L.hand, new THREE.Quaternion());
      const dH = handQ.clone().multiply(RQ(L.hand).clone().invert());
      // 手的横轴（食指 → 小指）在当前姿势下的方向
      const ax = RP(L.pinky[0]).clone().sub(RP(L.index[0])).normalize().applyQuaternion(dH);
      const tracing = s === 'R';
      const curls = {
        index: tracing ? [4, 6, 4] : [14, 16, 10],
        middle: tracing ? [62, 78, 40] : [18, 20, 12],
        ring: tracing ? [70, 80, 40] : [22, 24, 14],
        pinky: tracing ? [74, 76, 40] : [26, 26, 16],
      };
      const sign = s === 'L' ? 1 : -1;
      for (const [name, angles] of Object.entries(curls)) {
        let a = 0;
        L[name].forEach((b, i) => {
          a += angles[i] * D2R;
          const d = new THREE.Quaternion().setFromAxisAngle(ax, a * sign).multiply(dH);
          setDelta(b, d);
        });
      }
      // 拇指往掌心收一点
      let a = 0;
      L.thumb.forEach((b, i) => {
        a += (tracing ? [10, 20, 16] : [6, 10, 8])[i] * D2R;
        const fwd = RP(L.middle[0]).clone().sub(RP(L.hand)).normalize().applyQuaternion(dH);
        setDelta(b, new THREE.Quaternion().setFromAxisAngle(fwd, a * sign).multiply(dH));
      });
    }
  }

  function update(dt, time, cameraWorldPos) {
    root.updateWorldMatrix(true, false);
    camLocal.copy(cameraWorldPos);
    root.worldToLocal(camLocal);

    // —— 头部：在“看图纸”与“看主角”之间过渡 ——
    tmp.subVectors(camLocal, HEAD_C);
    const yawRaw = Math.atan2(tmp.x, tmp.z);
    state.canSee = Math.abs(yawRaw) < 118 * D2R;
    const yaw = clamp(yawRaw, -70 * D2R, 70 * D2R);
    const pitch = clamp(Math.atan2(tmp.y, Math.hypot(tmp.x, tmp.z)), -40 * D2R, 34 * D2R);
    dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    // 微微歪着头（“一脸茫然”）
    quatFromForward(dir, 0.14 * Math.sign(yaw || 1) * Math.min(1, Math.abs(yaw) / 0.5), qLook);
    const want = state.canSee ? state.lookTarget : 0;
    state.look = damp(state.look, want, state.lookSpeed, dt);
    const lw = state.look * state.look * (3 - 2 * state.look);
    qHead.copy(qWork).slerp(qLook, lw);
    // 轻微的呼吸
    _q1.setFromAxisAngle(_v4.set(1, 0, 0), Math.sin(time * 1.3) * 0.012);
    qHead.premultiply(_q1);
    qNeck.copy(chestDelta).slerp(qHead, 0.45);
    setDelta(bn.neck, qNeck);
    setDelta(bn.head, qHead);
    // 眼珠：看主角时再多转一点，正对镜头
    tmp.subVectors(camLocal, HEAD_C).normalize();
    const fwdH = _v4.set(0, 0, 1).applyQuaternion(qHead);
    qEye.setFromUnitVectors(fwdH, tmp);
    _q1.identity().slerp(qEye, 0.5 * lw);
    qEye.copy(_q1).multiply(qHead);
    setDelta(bn.eye.L, qEye);
    setDelta(bn.eye.R, qEye);

    // —— 表情（含眨眼） ——
    const ex = EXPR[state.expression] || EXPR.neutral;
    state.expr.lid = damp(state.expr.lid, ex.lid, 10, dt);
    state.expr.mouth = damp(state.expr.mouth, ex.mouth, 8, dt);
    state.nextBlink -= dt;
    if (state.nextBlink < 0) {
      state.blink = 1;
      state.nextBlink = 2.5 + Math.random() * 4;
    }
    state.blink = Math.max(0, state.blink - dt * 7);
    const blink = Math.sin(state.blink * Math.PI);
    const lid = state.expr.lid + blink * (0.026 - state.expr.lid);
    for (const l of lidBones) l.b.position.copy(l.rest).addScaledVector(l.dir, lid * l.w);
    for (const m of mouthBones) m.b.position.copy(m.rest).addScaledVector(m.dir, state.expr.mouth);

    // —— 指尖在纸上描画 ——
    state.tracing = damp(state.tracing, state.tracingTarget * (1 - 0.8 * state.look), 2.2, dt);
    state.traceT += dt * state.tracing;
    const tt = state.traceT;
    wristTarget.R.copy(WRIST_REST.R);
    wristTarget.R.x += 0.028 * Math.sin(tt * 0.9) + 0.01 * Math.sin(tt * 2.3 + 1.0);
    wristTarget.R.z += 0.024 * Math.sin(tt * 0.63 + 0.7) + 0.008 * Math.sin(tt * 1.9);
    wristTarget.L.copy(WRIST_REST.L);

    // —— 手臂 ——
    for (const side of ['L', 'R']) {
      const r = state.reach[side];
      r.w = damp(r.w, r.target, 3.0, dt);
      const w = r.w * r.w * (3 - 2 * r.w);
      tmp.copy(wristTarget[side]);
      if (w > 0.001) tmp.lerp(r.to, w);
      poseArm(side, tmp, w);
    }
  }

  const tipLocal = { R: new THREE.Vector3() };
  const api = {
    group: root,
    head,
    state,
    update,
    /** 让她看向 / 不看主角 */
    setLook(v, speed = 3.2) {
      state.lookTarget = v;
      state.lookSpeed = speed;
    },
    setTracing(v) {
      state.tracingTarget = v;
    },
    setExpression(name) {
      state.expression = name;
    },
    /** 让一只手伸向某个世界坐标（掌心朝上）；w=0 收回 */
    setReach(side, w, worldTarget) {
      const r = state.reach[side];
      r.target = w;
      if (worldTarget) {
        r.to.copy(worldTarget);
        root.worldToLocal(r.to);
      }
    },
    /** 指尖的世界坐标（纸面的光跟着它走） */
    fingertipWorld(out) {
      const b = bn.R.index[2];
      b.updateWorldMatrix(true, false);
      // 第三节指骨再往前一点就是指尖
      return b.localToWorld(out.copy(tipLocal.R));
    },
    /** 掌心上方（放杯子的位置）的世界坐标 */
    palmWorld(side, out) {
      const L = bn[side];
      L.middle[0].updateWorldMatrix(true, false);
      L.hand.getWorldPosition(out);
      L.middle[0].getWorldPosition(_v1);
      out.lerp(_v1, 0.6);
      root.worldToLocal(out);
      out.y += state.reach[side].w > 0.5 ? 0.03 : 0.025;
      return root.localToWorld(out);
    },
    headWorld(out) {
      head.updateWorldMatrix(true, false);
      return head.getWorldPosition(out);
    },
    /** 缎带的锚点（局部坐标） */
    wristLocal(side, out) {
      return posInRoot(bn[side].hand, out);
    },
    clipLocalNow(side, out) {
      const c = clips[side];
      c.updateWorldMatrix(true, false);
      return root.worldToLocal(c.getWorldPosition(out));
    },
    WRIST_REST,
    /** 她在主角的哪一侧更顺手 */
    nearerSide(cameraWorldPos) {
      camLocal.copy(cameraWorldPos);
      root.worldToLocal(camLocal);
      return camLocal.x >= 0 ? 'L' : 'R';
    },
  };

  // 先解一次姿势（手指按手的初始朝向弯好），缎带初始化时手腕位置才正确
  update(0, 0, root.localToWorld(V(0, 1.6, 3)));
  poseFingers();
  {
    // 指尖：食指末节骨长度再往前一截
    const b = bn.R.index[2];
    const len = RP(b).distanceTo(RP(bn.R.index[1]));
    tipLocal.R.set(0, len * 0.9, 0);
  }
  root.updateMatrixWorld(true);
  return api;
}
