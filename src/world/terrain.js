import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeNoise2D, fbm, smoothstep, mulberry32 } from '../util/noise.js';

/** 丘顶高度 / 平坦丘顶的半径（巨大用纸就铺在这块平地上） */
export const HILL_TOP = 14;
export const PLATEAU_R = 9.5;
const HILL_R = 88;

const nBig = makeNoise2D(11);
const nSmall = makeNoise2D(29);

/** 地形高度。丘顶是一块完全平坦的圆台，往外沿余弦曲线缓缓落下。 */
export function heightAt(x, z) {
  const r = Math.hypot(x, z);
  let prof;
  if (r <= PLATEAU_R) prof = 1;
  else if (r >= HILL_R) prof = 0;
  else prof = 0.5 * (1 + Math.cos((Math.PI * (r - PLATEAU_R)) / (HILL_R - PLATEAU_R)));
  let h = HILL_TOP * prof;
  h += (fbm(nBig, x * 0.028 + 7.3, z * 0.028 - 2.1, 4) - 0.5) * 5.0 * smoothstep(PLATEAU_R, 36, r);
  h += (fbm(nSmall, x * 0.16, z * 0.16, 3) - 0.5) * 0.5 * smoothstep(PLATEAU_R, 17, r);
  return h;
}

function makeGroundTexture() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const n = makeNoise2D(5);
  const rand = mulberry32(77);
  // 可平铺的苔绿色底：用周期坐标采样噪声
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      // 四角混合得到无缝平铺
      const a = fbm(n, u * 8, v * 8, 4);
      const b = fbm(n, (u - 1) * 8, v * 8, 4);
      const cc = fbm(n, u * 8, (v - 1) * 8, 4);
      const d = fbm(n, (u - 1) * 8, (v - 1) * 8, 4);
      const wx = u;
      const wy = v;
      const f = a * (1 - wx) * (1 - wy) + b * wx * (1 - wy) + cc * (1 - wx) * wy + d * wx * wy;
      const speck = rand();
      let r = 36 + f * 46;
      let g = 62 + f * 70;
      let bl = 34 + f * 30;
      if (speck > 0.992) {
        // 远看像是星星点点的白花
        r = 200; g = 208; bl = 226;
      } else if (speck > 0.93) {
        // 草尖的亮斑
        r += 46; g += 52; bl += 8;
      } else if (speck < 0.12) {
        r *= 0.55; g *= 0.55; bl *= 0.6;
      }
      const i = (y * S + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = bl;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export function createTerrain() {
  const group = new THREE.Group();
  group.name = 'terrain';

  // —— 山丘本体 ——
  const SIZE = 280;
  const SEG = 280;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const nTint = makeNoise2D(41);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, heightAt(x, z));
    const t = 0.72 + 0.5 * fbm(nTint, x * 0.05, z * 0.05, 3);
    colors[i * 3] = t * 0.92;
    colors[i * 3 + 1] = t;
    colors[i * 3 + 2] = t * 0.95;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  // 把法线往正上方掰：背着月亮的南坡也能均匀地接到月光，不至于漆黑一片
  {
    const nor = geo.attributes.normal;
    const n = new THREE.Vector3();
    for (let i = 0; i < nor.count; i++) {
      n.fromBufferAttribute(nor, i).lerp(THREE.Object3D.DEFAULT_UP, 0.8).normalize();
      nor.setXYZ(i, n.x, n.y, n.z);
    }
  }
  const tex = makeGroundTexture();
  tex.repeat.set(70, 70);
  const ground = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ map: tex, vertexColors: true }),
  );
  ground.receiveShadow = true;
  group.add(ground);

  // —— 远处的平地（被雾吞掉的城镇地面）——
  const far = new THREE.Mesh(
    new THREE.CircleGeometry(1600, 48).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x0c1a14 }),
  );
  far.position.y = -3.2;
  group.add(far);

  // —— 森林剪影（绿化后的城市外缘）——
  const rand = mulberry32(2024);
  const cone1 = new THREE.ConeGeometry(0.42, 1.0, 7).translate(0, 0.75, 0);
  const cone2 = new THREE.ConeGeometry(0.32, 0.8, 7).translate(0, 1.2, 0);
  const cone3 = new THREE.ConeGeometry(0.2, 0.6, 7).translate(0, 1.6, 0);
  const trunk = new THREE.CylinderGeometry(0.05, 0.07, 0.4, 5).translate(0, 0.2, 0);
  const treeGeo = mergeGeometries([cone1, cone2, cone3, trunk]);
  const treeMat = new THREE.MeshLambertMaterial({ color: 0x0b1c17 });
  const TREE_N = 1500;
  const trees = new THREE.InstancedMesh(treeGeo, treeMat, TREE_N);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const nForest = makeNoise2D(91);
  let placed = 0;
  let guard = 0;
  while (placed < TREE_N && guard++ < 40000) {
    const ang = rand() * Math.PI * 2;
    const r = 50 + Math.pow(rand(), 0.8) * 170;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    // 森林在近处稀、远处密；留出林间空地
    const dens = smoothstep(46, 80, r) * (0.35 + 0.9 * fbm(nForest, x * 0.02, z * 0.02, 3));
    if (rand() > dens) continue;
    const y = r < SIZE / 2 - 2 ? heightAt(x, z) : -3.2;
    const sc = 3.5 + rand() * 5;
    p.set(x, y - 0.3, z);
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rand() * Math.PI * 2);
    s.set(sc * (0.8 + rand() * 0.5), sc, sc * (0.8 + rand() * 0.5));
    m.compose(p, q, s);
    trees.setMatrixAt(placed++, m);
  }
  trees.count = placed;
  trees.instanceMatrix.needsUpdate = true;
  group.add(trees);

  // —— 没有灯光的城镇剪影 ——
  const CITY_N = 520;
  const city = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    new THREE.MeshLambertMaterial({ color: 0x060b12 }),
    CITY_N,
  );
  const nCity = makeNoise2D(133);
  placed = 0;
  guard = 0;
  while (placed < CITY_N && guard++ < 20000) {
    const ang = rand() * Math.PI * 2;
    const r = 300 + rand() * 520;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    const d = fbm(nCity, x * 0.004, z * 0.004, 3);
    if (d < 0.5) continue; // 城区成片分布
    const tall = rand() < 0.07;
    const h = tall ? 30 + rand() * 34 : 7 + rand() * 18;
    const w = 12 + rand() * 26;
    p.set(x, -3.5, z);
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rand() * Math.PI);
    s.set(w, h, 10 + rand() * 22);
    m.compose(p, q, s);
    city.setMatrixAt(placed++, m);
  }
  city.count = placed;
  city.instanceMatrix.needsUpdate = true;
  group.add(city);

  // —— 天际的山影 ——
  const RING_SEG = 256;
  const ringPos = [];
  const ringIdx = [];
  const nMount = makeNoise2D(7);
  for (let i = 0; i <= RING_SEG; i++) {
    const a = (i / RING_SEG) * Math.PI * 2;
    const R = 1250;
    const hgt = 14 + 120 * Math.pow(fbm(nMount, Math.cos(a) * 3 + 10, Math.sin(a) * 3 + 10, 5), 1.9);
    ringPos.push(Math.cos(a) * R, -20, Math.sin(a) * R, Math.cos(a) * R, hgt, Math.sin(a) * R);
    if (i < RING_SEG) {
      const k = i * 2;
      ringIdx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const ringGeo = new THREE.BufferGeometry();
  ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(ringPos, 3));
  ringGeo.setIndex(ringIdx);
  const mountains = new THREE.Mesh(
    ringGeo,
    new THREE.MeshBasicMaterial({ color: 0x07142b, fog: false, side: THREE.DoubleSide }),
  );
  mountains.renderOrder = -5;
  group.add(mountains);

  return { group, ground };
}
