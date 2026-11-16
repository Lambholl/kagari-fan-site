import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { characterToon, addSkinnedOutline, addOutline } from './materials.js';
import { smoothstep, lerp, clamp, damp } from '../util/noise.js';
import { drapeSeatedSkirt } from './skirt.js';
import { prepareSleeve } from './sleeves.js';
import { trackLoad } from '../loading.js';

// 篝：模型来自 v9-rigged.blend（来源与许可见 public/models/SOURCES.md），
// 骨架为 VRM 式 J_Bip_*，表情使用 Fcl_* 形态键，腕上飘带由 ribbons.js 绘制。
// 局部坐标：原点为骨盆正下方的纸面，+z 为她面朝的方向，+x 为她的左手边。

const D2R = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const MODEL_URL = `${import.meta.env.BASE_URL}models/kagari-base.glb`;

// —— 跪坐姿势参数（两膝略分，上身前倾，双手按在两膝前的纸面上） ——
const HIP_Y = 0.17; // 骨盆关节离纸面的高度（米）
const HIP_Z = -0.09;
const PELVIS_TILT = 22 * D2R;
const SPINE_BEND = [7, 6, 4].map((d) => d * D2R); // Spine、Chest 与 UpperChest 向前弯曲的增量角度（弧度）
const KNEE = { x: 0.10, y: 0.014 }; // 膝头离中线的距离、离纸面的高度
// 前倾后手腕离肩稍远：上臂、前臂各拉长一点，手才按得到纸面
const ARM_STRETCH = 1.1;
// 手腕平时按在纸上的位置
const WRIST_REST = { L: V(0.052, 0.032, 0.236), R: V(-0.048, 0.034, 0.248) };

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
  const front = 0.319;
  const side = 0.43;
  const back = 0.54;
  let r = side + (c > 0 ? (front - side) * Math.pow(c, 1.6) : (back - side) * Math.pow(-c, 1.3));
  r *= 1 + 0.06 * Math.sin(3 * phi + 0.8) + 0.04 * Math.sin(5 * phi + 2.1) + 0.025 * Math.sin(9 * phi + 4.0);
  return r;
}

/**
 * 采样跪坐裙摆曲面上的点（局部坐标，米）。
 * phi 为自正前方转向她左手边的弧度，v 从 0（腰）到 1（裙边）。
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

// —————————————————————— 材质 ——————————————————————

// 眉毛、睫毛、眼线与眼高光贴片使用 Alpha 混合，关闭深度写入并在面部之后绘制。
const FACE_DETAIL = /FaceBrow|FaceEyelash|FaceEyeline|EyeHighlight/;
// 五官贴片与虹膜材质本身已有线条，排除在通用外轮廓描边之外。
const NO_OUTLINE = /_FACE$|_EYE$/;
// 多层平铺裙面与领口背面装饰排除通用描边，防止背面外壳穿透上层布面。
const NO_OUTLINE_MESH = /kirt|Petticoat|flounce|Crimson_|Back_.*bow|Cuff_bindingR001_2/i;

/** 将 GLB 中的 PBR 材质转换为角色卡通材质，保留原有基础贴图与法线贴图。 */
function toonFrom(src) {
  const n = src.name || '';
  const map = src.map || null;
  const profile = /SKIN/.test(n) ? 'skin'
    : /_EYE$|_FACE$/.test(n) ? 'detail'
    : /HAIR/.test(n) ? 'hair'
    : /Petticoat/.test(n) ? 'frill'
    : /Ribbon/.test(n) ? 'ribbon' : 'cloth';
  const color = /FaceMouth/.test(n) ? 0xc7a5a3
    : /Ribbon \| crimson/.test(n) ? 0x8050a0 : map ? 0xffffff : src.color.getHex();
  const m = characterToon(color, profile, {
    map, side: THREE.DoubleSide,
    normalMap: src.normalMap, normalScale: src.normalScale,
  });
  m.name = n;
  if (/Ribbon \| crimson/.test(n)) {
    m.map = null;
  }
  if (/Face_00_SKIN/.test(n)) {
    // 在面部绑定坐标空间叠加双颊腮红，使其随面部蒙皮与形态键一同变形。
    const characterShader = m.onBeforeCompile;
    m.onBeforeCompile = (shader) => {
      characterShader(shader);
      shader.uniforms.uBlush = { value: new THREE.Color(0xe98499) };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFaceRest;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFaceRest = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFaceRest;\nuniform vec3 uBlush;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          // 仅加深唇线区域原有的红色墨线，保留立体唇面的明暗过渡。
          float lipRegion = (1.0 - smoothstep(0.008, 0.014, abs(vFaceRest.x)))
            * (1.0 - smoothstep(0.001, 0.004, abs(vFaceRest.y - 1.256)))
            * smoothstep(0.055, 0.075, vFaceRest.z);
          float lipInk = smoothstep(0.07, 0.22, diffuseColor.r - diffuseColor.g);
          diffuseColor.rgb *= mix(vec3(1.0), vec3(0.78, 0.69, 0.72), lipRegion * lipInk * 0.48);
          vec2 cheek = vec2((abs(vFaceRest.x) - 0.052) / 0.025, (vFaceRest.y - 1.27) / 0.012);
          float blush = exp(-dot(cheek, cheek) * 1.8) * smoothstep(0.015, 0.035, vFaceRest.z);
          diffuseColor.rgb = mix(diffuseColor.rgb, uBlush, blush * 0.38);
        `);
    };
    m.customProgramCacheKey = () => 'character-toon-v1-skin-blush-lips';
  }
  if (FACE_DETAIL.test(n)) {
    m.transparent = true;
    m.depthWrite = false;
  } else if (src.transparent || src.alphaTest > 0) {
    m.alphaTest = 0.5;
  }
  return m;
}

// —————————————————————— 骨骼工具 ——————————————————————

function setupRig(body) {
  const bones = new Map();
  const meshes = [];
  let skeleton = null;
  body.traverse((o) => {
    if (o.isBone) bones.set(o.name, o);
    if (o.isMesh) meshes.push(o);
    if (o.isSkinnedMesh && !skeleton) skeleton = o.skeleton;
  });
  if (!skeleton) throw new Error('kagari: model has no skinned mesh');
  const B = (n) => {
    const b = bones.get(n);
    if (!b) throw new Error(`kagari: bone ${n} not found`);
    return b;
  };

  // 回到绑定姿势
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

  // 拉长手臂：子骨沿父骨方向挪远，蒙皮会在两骨交界处被均匀拉开
  for (const s of ['L', 'R']) {
    for (const n of [`J_Bip_${s}_LowerArm`, `J_Bip_${s}_Hand`]) B(n).position.multiplyScalar(ARM_STRETCH);
  }
  body.updateMatrixWorld(true);
  return { B, bones, meshes };
}

/** 从 first 开始顺着唯一的子骨往下走，得到一条骨骼链 */
function boneChain(first) {
  const out = [first];
  for (let b = first; ; ) {
    const c = b.children.find((o) => o.isBone);
    if (!c) break;
    out.push(c);
    b = c;
  }
  return out;
}

// —————————————————————— 创建 ——————————————————————

/** 加载角色模型并构建跪坐姿势、裙摆网格与每帧动画控制接口；缺少蒙皮或必需骨骼时抛错。 */
export async function createKagari() {
  const root = new THREE.Group();
  root.name = 'kagari';

  const gltf = await trackLoad((onProgress) => new GLTFLoader().loadAsync(MODEL_URL, onProgress));
  const body = gltf.scene;
  root.add(body);
  const { B, bones, meshes } = setupRig(body);

  // —— 材质与描边 ——
  const converted = new Map();
  const outlined = [];
  for (const m of meshes) {
    const src = m.material;
    if (!converted.has(src)) converted.set(src, toonFrom(src));
    m.material = converted.get(src);
    if (FACE_DETAIL.test(src.name)) m.renderOrder = 1;
    if (m.isSkinnedMesh && !NO_OUTLINE.test(src.name) && !FACE_DETAIL.test(src.name) && !NO_OUTLINE_MESH.test(m.name)) outlined.push(m);
    m.frustumCulled = false;
    m.raycast = () => {};
  }
  for (const m of outlined) {
    const hair = /HAIR/.test(m.material.name);
    const face = /Face_00_SKIN/.test(m.material.name);
    // 领口上衣（Cuff_bindingR001_*）有多层薄布，与面部外轮廓共用更细的描边以避免穿透布面。
    const top = m.name.startsWith('Cuff_bindingR001_');
    addSkinnedOutline(m, face || top ? 0.00065 : hair ? 0.0012 : 0.0014, face ? 0x4c3b48 : 0x182238);
  }
  const faceMeshes = meshes.filter((m) => m.morphTargetDictionary && m.morphTargetInfluences);

  // —— 绑定姿势下的参考量（此时 root 是单位变换，世界 = 局部） ——
  const restQ = new Map();
  const restP = new Map();
  const J = (s, n) => B(`J_Bip_${s}_${n}`);
  const bn = {
    hips: B('J_Bip_C_Hips'),
    spine: [B('J_Bip_C_Spine'), B('J_Bip_C_Chest'), B('J_Bip_C_UpperChest')],
    neck: B('J_Bip_C_Neck'),
    head: B('J_Bip_C_Head'),
    eye: { L: B('J_Adj_L_FaceEye'), R: B('J_Adj_R_FaceEye') },
  };
  for (const s of ['L', 'R']) {
    const f = (n) => [1, 2, 3].map((i) => J(s, `${n}${i}`));
    bn[s] = {
      thigh: J(s, 'UpperLeg'),
      shin: J(s, 'LowerLeg'),
      foot: J(s, 'Foot'),
      toe: J(s, 'ToeBase'),
      upper: J(s, 'UpperArm'),
      fore: J(s, 'LowerArm'),
      hand: J(s, 'Hand'),
      index: f('Index'),
      middle: f('Middle'),
      ring: f('Ring'),
      pinky: f('Little'),
      thumb: f('Thumb'),
    };
  }
  body.traverse((o) => {
    if (!o.isBone) return;
    restQ.set(o, o.getWorldQuaternion(new THREE.Quaternion()));
    restP.set(o, o.getWorldPosition(new THREE.Vector3()));
  });
  const RP = (b) => restP.get(b);
  const RQ = (b) => restQ.get(b);
  const poseSleeve = Object.fromEntries(['L', 'R'].map((side) => [
    side, prepareSleeve(side, bn[side].upper, bones, meshes),
  ]));
  // 头的中心（球心）：由眼睛和头骨的位置推出来
  const eyeMid = RP(bn.eye.L).clone().add(RP(bn.eye.R)).multiplyScalar(0.5);
  const HEAD_CENTER_REST = V(0, eyeMid.y + 0.01, RP(bn.head).z + 0.01);

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

  /** 骨骼链在绑定姿势下各节的方向与长度（末节没有子骨，沿用上一节的方向） */
  const chainRest = (chain) => {
    const dirs = [];
    const lens = [];
    chain.forEach((b, i) => {
      if (i < chain.length - 1) {
        const d = RP(chain[i + 1]).clone().sub(RP(b));
        lens.push(d.length());
        dirs.push(d.normalize());
      } else {
        dirs.push(i > 0 ? dirs[i - 1].clone() : V(0, -1, 0));
        lens.push(i > 0 ? lens[i - 1] * 0.8 : 0.05);
      }
    });
    return { chain, dirs, lens };
  };
  /** 依次把链上每一节转向 aim(起点, 长度, 第几节) 给出的方向（最小旋转，不扭） */
  const qAim = new THREE.Quaternion();
  const chainP = new THREE.Vector3();
  const chainD = new THREE.Vector3();
  const aimChain = (info, aim) => {
    posInRoot(info.chain[0], chainP);
    info.chain.forEach((b, k) => {
      aim(chainP, info.lens[k], k, chainD);
      setDelta(b, qAim.setFromUnitVectors(info.dirs[k], chainD));
      chainP.addScaledVector(chainD, info.lens[k]);
    });
  };

  // —————————— 1. 躯干 ——————————
  const torsoDelta = [];
  const hipsDelta = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), PELVIS_TILT);
  {
    const parentM = new THREE.Matrix4();
    bn.hips.parent.updateWorldMatrix(true, false);
    parentM.copy(root.matrixWorld).invert().multiply(bn.hips.parent.matrixWorld).invert();
    bn.hips.position.copy(V(0, HIP_Y, HIP_Z).applyMatrix4(parentM));
    let a = PELVIS_TILT;
    setDelta(bn.hips, hipsDelta);
    bn.spine.forEach((b, i) => {
      a += SPINE_BEND[i];
      const d = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), a);
      torsoDelta.push(d);
      setDelta(b, d);
    });
  }
  const chestDelta = torsoDelta[torsoDelta.length - 1];

  // —————————— 2. 腿：跪坐（大腿向前，膝头略分开，小腿折回压在身下） ——————————
  const legCaps = [];
  for (const s of ['L', 'R']) {
    const sg = s === 'L' ? 1 : -1;
    const L = bn[s];
    const T = posInRoot(L.thigh, new THREE.Vector3());
    const kx = sg * KNEE.x - T.x;
    const ky = KNEE.y - T.y;
    const kz = Math.sqrt(Math.max(0.01, L.len.thigh ** 2 - kx * kx - ky * ky));
    const t = V(kx, ky, kz).normalize();
    // 膝盖朝前上方，稍向内扣：小腿折回时脚跟落在臀下、略向外
    const tilt = 8 * D2R;
    const k = V(-sg * Math.sin(tilt), Math.cos(tilt), 0);
    k.addScaledVector(t, -k.dot(t)).normalize();
    setDelta(L.thigh, deltaFromBasis(L.thigh, t, k, new THREE.Quaternion()));
    // 将小腿折回身下，允许脚部略低于纸面以保证臀下裙面平顺。
    const fold = 135 * D2R;
    const sd = t.clone().multiplyScalar(Math.cos(fold)).addScaledVector(k, -Math.sin(fold)).normalize();
    const sf = k.clone().multiplyScalar(Math.cos(fold)).addScaledVector(t, Math.sin(fold)).normalize();
    setDelta(L.shin, deltaFromBasis(L.shin, sd, sf, new THREE.Quaternion()));
    // 脚尖向后、略向下，鞋跟也留在裙摆下面。
    const fd = V(0, -0.1, -1).normalize();
    const dFoot = deltaFromBasis(L.foot, fd, V(0, -1, 0), new THREE.Quaternion());
    setDelta(L.foot, dFoot);
    setDelta(L.toe, dFoot);
    const K = posInRoot(L.shin, new THREE.Vector3());
    legCaps.push({ a: T.clone(), b: K.clone(), ra: 0.064, rb: 0.062 });
  }
  CAPS.length = 0;
  CAPS.push(...legCaps);
  const hipsP = posInRoot(bn.hips, new THREE.Vector3());
  CAPS.push({ a: V(0, 0.08, hipsP.z - 0.03), b: V(0, 0.08, hipsP.z - 0.031), ra: 0.115, rb: 0.115 });

  // —————————— 3. 裙摆：每条裙骨链顺着 skirtPoint 的曲面摊到纸上 ——————————
  const skirtChains = [...bones.values()].filter((b) => /^Skirt_.+_01[LR]?$/.test(b.name)).map((b) => chainRest(boneChain(b)));
  const restWaist = new THREE.Vector3();
  {
    // 腰线：裙骨根部那一圈的中心，跟着骨盆的倾斜一起转
    const ring = new THREE.Vector3();
    for (const c of skirtChains) ring.add(RP(c.chain[0]));
    ring.divideScalar(Math.max(1, skirtChains.length));
    ring.x = 0;
    restWaist.copy(ring);
    WAIST_R = skirtChains.reduce((r, c) => r + Math.hypot(RP(c.chain[0]).x, RP(c.chain[0]).z - ring.z), 0) / Math.max(1, skirtChains.length);
    WAIST = hipsP.clone().add(ring.clone().sub(RP(bn.hips)).applyQuaternion(hipsDelta));
    HEMC = V(0, 0, hipsP.z + 0.05);
    const curve = (phi, v, out) => {
      skirtPoint(phi, Math.min(v, 1), out);
      // 比曲面更长的布顺着纸面继续往外铺
      if (v > 1) out.add(_v4.set(Math.sin(phi), 0, Math.cos(phi)).multiplyScalar((v - 1) * 0.3));
      return out;
    };
    const q = new THREE.Vector3();
    for (const c of skirtChains) {
      const tip = RP(c.chain[c.chain.length - 1]);
      const phi = Math.atan2(tip.x - ring.x, tip.z - ring.z);
      let v = 0;
      aimChain(c, (P, len, k, out) => {
        // 沿曲面往外找第一个离当前关节一节骨长的点
        while (v < 3 && curve(phi, v, q).distanceTo(P) < len) v += 0.01;
        out.subVectors(curve(phi, v, q), P).normalize();
        // 骨骼是直的，整段弦需避开臀部与大腿。
        for (let it = 0; it < 4; it++) {
          let lift = 0;
          for (const s of [0.25, 0.5, 0.75, 1]) {
            _v3.copy(P).addScaledVector(out, len * s);
            const bh = bodyHeight(_v3.x, _v3.z);
            if (bh > 0) lift = Math.max(lift, (bh + 0.016 - _v3.y) / s);
          }
          if (lift <= 1e-4) break;
          out.multiplyScalar(len);
          out.y += lift;
          out.normalize();
        }
      });
    }
  }
  const seatedSkirt = drapeSeatedSkirt(root, meshes, skirtPoint, restWaist, bodyHeight);
  const outerSkirt = seatedSkirt.filter((m) => /Overskirt.*_1_seated$/.test(m.name));
  // 仅对外裙外层和最外层荷叶边添加细描边。
  for (const m of seatedSkirt) {
    if (/Overskirt.*_1_seated$/.test(m.name)) addOutline(m, 0.0013, 0x182238);
    else if (/single_sewn_flounce_seated$/.test(m.name)) addOutline(m, 0.0008, 0x263249);
  }
  const clothRay = new THREE.Raycaster();
  const clothOrigin = new THREE.Vector3();
  const down = V(0, -1, 0);
  function clothHeightAt(x, z) {
    root.updateMatrixWorld(true);
    root.localToWorld(clothOrigin.set(x, 2, z));
    clothRay.set(clothOrigin, down);
    const hit = clothRay.intersectObjects(outerSkirt, false)[0];
    return hit ? root.worldToLocal(hit.point).y : null;
  }

  /** 挂在骨骼上的“绑定姿势坐标系”：子物体按绑定姿势（站立、面朝 +z）的局部坐标摆放 */
  const restFrame = (bone, origin) => {
    const f = new THREE.Group();
    bone.add(f);
    f.quaternion.copy(RQ(bone)).invert();
    f.position.copy(origin).sub(RP(bone)).applyQuaternion(f.quaternion);
    return f;
  };
  const head = restFrame(bn.head, HEAD_CENTER_REST);

  // —————————— 4. 表情：形态键 ——————————
  // 闭嘴表情保留轻微的 Small 收缩权重，使玩家在正常视距下仍能看清唇线。
  const CLOSED_MOUTH = { Fcl_MTH_Neutral: -0.1, Fcl_MTH_Small: 0.18, Fcl_MTH_Close: 1, Fcl_MTH_A: -0.045 };
  const EXPR = {
    neutral: { ...CLOSED_MOUTH, Fcl_EYE_Close: 0.025 },
    stare: { ...CLOSED_MOUTH, Fcl_EYE_Surprised: 0.06, Fcl_BRW_Surprised: 0.04 },
    // 微笑表情通过微调 Fcl_MTH_Up 轻抬嘴角，避免使用会张大嘴巴的 Joy 权重。
    smile: { Fcl_EYE_Joy: 0.1, Fcl_MTH_Up: 0.12, Fcl_MTH_Close: 0.75, Fcl_BRW_Joy: 0.12 },
  };
  const EXPR_KEYS = [...new Set(Object.values(EXPR).flatMap((e) => Object.keys(e)))];
  const setMorph = (name, w) => {
    for (const m of faceMeshes) {
      const i = m.morphTargetDictionary[name];
      if (i !== undefined) m.morphTargetInfluences[i] = w;
    }
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
    expr: Object.fromEntries(EXPR_KEYS.map((k) => [k, EXPR.neutral[k] || 0])),
    canSee: false,
    blink: 0,
    nextBlink: 2.5,
  };

  const shoulder = { L: posInRoot(bn.L.upper, new THREE.Vector3()), R: posInRoot(bn.R.upper, new THREE.Vector3()) };
  const HEAD_C = new THREE.Vector3();
  head.updateWorldMatrix(true, false);
  root.worldToLocal(head.getWorldPosition(HEAD_C));

  // 看图纸时的头部姿态：低着头看手边，略偏向描画的那只手
  const WORK_PITCH = -3 * D2R;
  const WORK_YAW = 5 * D2R;
  const qWork = quatFromForward(
    V(Math.sin(WORK_YAW) * Math.cos(WORK_PITCH), -Math.sin(WORK_PITCH), Math.cos(WORK_YAW) * Math.cos(WORK_PITCH)),
    -0.025,
    new THREE.Quaternion(),
  );
  const qLook = new THREE.Quaternion();
  const qHead = new THREE.Quaternion();
  const qNeck = new THREE.Quaternion();
  const qEye = new THREE.Quaternion();
  const eyeDirection = new THREE.Vector3();
  const qHeadInv = new THREE.Quaternion();
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
    setDelta(L.fore, dFore);
    poseSleeve[s]();
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
        index: tracing ? [4, 6, 4] : [8, 12, 6],
        middle: tracing ? [20, 28, 16] : [10, 14, 8],
        ring: tracing ? [24, 32, 18] : [14, 16, 10],
        pinky: tracing ? [28, 34, 18] : [16, 18, 12],
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
    const yaw = clamp(yawRaw, -50 * D2R, 50 * D2R);
    const pitch = clamp(Math.atan2(tmp.y, Math.hypot(tmp.x, tmp.z)), -16 * D2R, 8 * D2R);
    dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    // 抬头回望姿态：轻抬下巴看向主角，肩膀与双手保持按在纸面上的原位。
    quatFromForward(dir, -0.02, qLook);
    const want = state.canSee ? state.lookTarget : 0;
    state.look = damp(state.look, want, state.lookSpeed, dt);
    const lw = state.look * state.look * (3 - 2 * state.look);
    qHead.copy(qWork).slerp(qLook, lw);
    // 轻微的呼吸
    _q1.setFromAxisAngle(_v4.set(1, 0, 0), Math.sin(time * 1.3) * 0.004);
    qHead.premultiply(_q1);
    qNeck.copy(chestDelta).slerp(qHead, 0.45);
    setDelta(bn.neck, qNeck);
    setDelta(bn.head, qHead);
    // 视线相对头部计算：低头时看手边，抬头时眼睛先迎向主角，避免眼珠翻到眼眶上缘。
    qHeadInv.copy(qHead).invert();
    eyeDirection.subVectors(camLocal, HEAD_C).normalize().applyQuaternion(qHeadInv);
    // 这个模型的虹膜是浅贴片，转动只需很小的幅度。
    const eyeYaw = clamp(Math.atan2(eyeDirection.x, eyeDirection.z), -2 * D2R, 2 * D2R);
    const eyePitch = lerp(-0.8 * D2R, clamp(Math.atan2(eyeDirection.y, Math.hypot(eyeDirection.x, eyeDirection.z)), -0.8 * D2R, 0.8 * D2R), lw);
    eyeDirection.set(Math.sin(eyeYaw * lw) * Math.cos(eyePitch), Math.sin(eyePitch), Math.cos(eyeYaw * lw) * Math.cos(eyePitch));
    quatFromForward(eyeDirection, 0, qEye);
    qEye.premultiply(qHead);
    setDelta(bn.eye.L, qEye);
    setDelta(bn.eye.R, qEye);

    // —— 表情（含眨眼） ——
    const ex = EXPR[state.expression] || EXPR.neutral;
    for (const k of EXPR_KEYS) state.expr[k] = damp(state.expr[k], ex[k] || 0, 10, dt);
    state.nextBlink -= dt;
    if (state.nextBlink < 0) {
      state.blink = 1;
      state.nextBlink = 2.5 + Math.random() * 4;
    }
    state.blink = Math.max(0, state.blink - dt * 7);
    const blink = Math.sin(state.blink * Math.PI);
    for (const k of EXPR_KEYS) {
      const w = state.expr[k];
      setMorph(k, k === 'Fcl_EYE_Close' ? w + blink * (1 - w)
        : k.startsWith('Fcl_EYE_') ? w * (1 - blink) : w);
    }

    // —— 指尖在纸上描画 ——
    state.tracing = damp(state.tracing, state.tracingTarget * (1 - lw), 3, dt);
    state.traceT += dt * state.tracing;
    const tt = state.traceT;
    wristTarget.R.copy(WRIST_REST.R);
    // 回望时减弱描画活跃度，让指尖停留在当前位置。
    wristTarget.R.x += 0.012 * Math.sin(tt * 0.9) + 0.004 * Math.sin(tt * 2.3 + 1.0);
    wristTarget.R.z += 0.01 * Math.sin(tt * 0.63 + 0.7) + 0.003 * Math.sin(tt * 1.9);
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
    seatedSkirt,
    clothHeightAt,
    update,
    /** 设置抬头看向主角的目标权重（0 看纸，1 看向主角）。 */
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
    /** 让一只手伸向世界坐标（掌心朝上），w 为 0 时收回。 */
    setReach(side, w, worldTarget) {
      const r = state.reach[side];
      r.target = w;
      if (worldTarget) {
        r.to.copy(worldTarget);
        root.worldToLocal(r.to);
      }
    },
    /** 指尖的世界坐标（纸面的光跟着它走）。 */
    fingertipWorld(out) {
      const b = bn.R.index[2];
      b.updateWorldMatrix(true, false);
      // 第三节指骨末端再往前延伸一段即为指尖坐标
      return b.localToWorld(out.copy(tipLocal.R));
    },
    /** 掌心上方（放杯子的位置）的世界坐标。 */
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
    /** 缎带的锚点（局部坐标）。 */
    wristLocal(side, out) {
      return posInRoot(bn[side].hand, out);
    },
    WRIST_REST,
    /** 她在主角的哪一侧更顺手。 */
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
    // 指尖：食指末节骨沿上一节的方向再往前一截（换算到末节骨的局部坐标）
    const b = bn.R.index[2];
    const d = RP(b).clone().sub(RP(bn.R.index[1]));
    tipLocal.R.copy(d).multiplyScalar(0.9).applyQuaternion(RQ(b).clone().invert());
  }
  root.updateMatrixWorld(true);
  return api;
}
