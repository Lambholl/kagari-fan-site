import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createSurfaceSampler } from './surface.js';
import { SCENE_LAYOUT } from './scene-layout.js';
import { repairTangents } from './tangents.js';
import { trackLoad } from '../loading.js';
import { createGroundDetailTexture, applyGroundDetail } from './ground-material.js';

/** 世界原点处山顶地面的基准高度（米）。 */
export const HILL_TOP = 14;
let sampleGround;

/** 当前可见地面的高度（米），须在场景加载后调用，网格外返回 NaN。 */
export function heightAt(x, z) {
  return sampleGround(x, z)?.height ?? NaN;
}

/** 返回可种花的平地或缓坡信息（主平台和远处地面都算），悬崖和树根附近返回 null。 */
export function flowerSurfaceAt(x, z) {
  const surface = sampleGround(x, z);
  if (!surface || surface.normalY < 0.9) return null;
  if (Math.hypot(x - SCENE_LAYOUT.tree.x, z - SCENE_LAYOUT.tree.z) < 0.9) return null;
  return surface;
}

/**
 * 当前可见地面在 (x, z) 处的高度（米）和法线竖直分量，须在场景加载后调用。
 * @returns {{ height: number, normalY: number } | null} 网格外返回 null。
 */
export function surfaceAt(x, z) {
  return sampleGround(x, z) ?? null;
}

/**
 * 判断从 (fromX, fromZ) 走到 (x, z) 是否是走出崖边：目标处有地面、不在主树树根范围内，
 * 并且比脚下低出 canWalkTo 允许的台阶高度，或者是往下的陡坡。须在场景加载后调用。
 * @returns {boolean} 是走出崖边时返回 true。
 */
export function isLedgeDrop(x, z, fromX, fromZ) {
  const surface = sampleGround(x, z);
  if (!surface) return false;
  if (Math.hypot(x - SCENE_LAYOUT.tree.x, z - SCENE_LAYOUT.tree.z) < SCENE_LAYOUT.tree.radius) return false;
  const drop = heightAt(fromX, fromZ) - surface.height;
  return drop > 0.22 + Math.hypot(x - fromX, z - fromZ) * 0.65 || (surface.normalY < 0.78 && drop > 0);
}

/** 检查一步移动是否符合地面坡度、高度差及主树避让约束，须在场景加载后调用。 */
export function canWalkTo(x, z, fromX, fromZ) {
  const surface = sampleGround(x, z);
  if (!surface || surface.normalY < 0.78) return false;
  const step = Math.abs(surface.height - heightAt(fromX, fromZ));
  if (step > 0.22 + Math.hypot(x - fromX, z - fromZ) * 0.65) return false;
  return Math.hypot(x - SCENE_LAYOUT.tree.x, z - SCENE_LAYOUT.tree.z) >= SCENE_LAYOUT.tree.radius;
}

// 接缝两侧这个距离内的法线完全对齐，再往外到 SEAM_FADE 逐渐恢复模型原有法线（米）。
const SEAM_FULL = 6;
const SEAM_FADE = 20;
// 估算共同法线时高度差分的步长（米），取地面的大致朝向。
const SEAM_STEP = 2;

/** 找出主平台贴着远处地面的边界边，按 SEAM_FADE 大小的水平方格索引。 */
function findSeamEdges(plateau, landscape) {
  const sampleLandscape = createSurfaceSampler(landscape);
  const { position } = plateau.geometry.attributes;
  const index = plateau.geometry.index;
  const world = Array.from({ length: position.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(plateau.matrixWorld));
  // UV 接缝处的顶点导出时被拆开，按坐标焊合后再找只属于一个三角面的边，否则 UV 接缝也会被当成边界。
  const welded = new Map();
  const ids = world.map((p, i) => {
    const key = `${Math.round(p.x * 100)},${Math.round(p.y * 100)},${Math.round(p.z * 100)}`;
    if (!welded.has(key)) welded.set(key, i);
    return welded.get(key);
  });
  const vertexAt = (i) => ids[index ? index.getX(i) : i];
  const edgeUses = new Map();
  for (let i = 0; i < (index ? index.count : position.count); i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = vertexAt(i + k);
      const b = vertexAt(i + (k + 1) % 3);
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edgeUses.set(key, (edgeUses.get(key) || 0) + 1);
    }
  }
  // 崖顶等悬空的边下方没有远处地面，不算接缝。
  const cells = new Map();
  const middle = new THREE.Vector3();
  const cellRange = (u, v) => [Math.floor((Math.min(u, v) - SEAM_FADE) / SEAM_FADE), Math.floor((Math.max(u, v) + SEAM_FADE) / SEAM_FADE)];
  for (const [key, uses] of edgeUses) {
    if (uses !== 1) continue;
    const [a, b] = key.split(',').map((i) => world[i]);
    middle.addVectors(a, b).multiplyScalar(0.5);
    const below = sampleLandscape(middle.x, middle.z);
    if (!below || Math.abs(below.height - middle.y) > 1.5) continue;
    const edge = new THREE.Line3(a, b);
    const [minX, maxX] = cellRange(a.x, b.x);
    const [minZ, maxZ] = cellRange(a.z, b.z);
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const cell = `${x},${z}`;
        if (!cells.has(cell)) cells.set(cell, []);
        cells.get(cell).push(edge);
      }
    }
  }
  return cells;
}

/**
 * 主平台边缘压在远处地面上，两块网格的顶点不重合，顶点法线也不同：平台边缘带坡度，远处地面在平台下方往下沉。
 * 接缝处因此有一条直的明暗线。把接缝两侧的顶点法线都过渡到同一个由可见地面高度差分得到的法线，两侧在接缝处的光照就一致了。
 */
function blendSeamNormals(plateau, landscape, sampleSurface) {
  const cells = findSeamEdges(plateau, landscape);
  const surfaceHeight = (x, z) => sampleSurface(x, z)?.height;
  const p = new THREE.Vector3();
  const closest = new THREE.Vector3();
  const n = new THREE.Vector3();
  const target = new THREE.Vector3();
  for (const mesh of [plateau, landscape]) {
    const { position, normal } = mesh.geometry.attributes;
    const toWorld = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const toLocal = toWorld.clone().invert();
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      const edges = cells.get(`${Math.floor(p.x / SEAM_FADE)},${Math.floor(p.z / SEAM_FADE)}`);
      if (!edges) continue;
      let distance = Infinity;
      for (const edge of edges) distance = Math.min(distance, edge.closestPointToPoint(p, true, closest).distanceTo(p));
      n.fromBufferAttribute(normal, i).applyMatrix3(toWorld).normalize();
      // 崖脚顶点也可能离接缝很近，只处理本身接近平地的顶点，保留崖壁的明暗。
      const weight = (1 - THREE.MathUtils.smoothstep(distance, SEAM_FULL, SEAM_FADE)) * THREE.MathUtils.smoothstep(n.y, 0.6, 0.85);
      if (weight <= 0) continue;
      const east = surfaceHeight(p.x + SEAM_STEP, p.z);
      const west = surfaceHeight(p.x - SEAM_STEP, p.z);
      const south = surfaceHeight(p.x, p.z + SEAM_STEP);
      const north = surfaceHeight(p.x, p.z - SEAM_STEP);
      if ([east, west, south, north].includes(undefined)) continue;
      target.set(west - east, 2 * SEAM_STEP, north - south).normalize();
      // 差分采样跨到了崖壁上，算出的不是这块地面的朝向。
      if (target.y < 0.85) continue;
      n.lerp(target, weight).normalize().applyMatrix3(toLocal).normalize();
      normal.setXYZ(i, n.x, n.y, n.z);
    }
    normal.needsUpdate = true;
  }
}

/** 加载地形、主树与远景树林模型，并初始化地面高度采样器。 */
export async function createTerrain({ mobile = false } = {}) {
  const quality = mobile ? 'mobile' : 'desktop';
  const loader = new GLTFLoader();
  const load = async (name) => (await trackLoad((onProgress) => loader.loadAsync(`${import.meta.env.BASE_URL}models/${name}.glb`, onProgress))).scene;
  const [ground, tree, forest] = await Promise.all([
    load('ground-desktop'), load(`tree-game-${quality}`),
    load('forest-desktop'),
  ]);
  const group = new THREE.Group();
  group.name = 'terrain';
  group.rotation.y = SCENE_LAYOUT.yaw;
  group.position.set(SCENE_LAYOUT.offsetX, HILL_TOP, SCENE_LAYOUT.offsetZ);
  // 主树导出时已应用场景比例，这里只缩放地形与外围树林。
  const landscape = new THREE.Group();
  landscape.scale.setScalar(SCENE_LAYOUT.scale);
  landscape.add(ground, forest);
  group.add(landscape, tree);
  group.updateMatrixWorld(true);
  const originalSampler = createSurfaceSampler(ground);
  // 平移整套场景，使世界原点处的地面落在预设山顶高度。
  group.position.y += HILL_TOP - originalSampler(0, 0).height;
  group.updateMatrixWorld(true);
  sampleGround = createSurfaceSampler(ground);
  blendSeamNormals(ground.getObjectByName('Game_Plateau'), ground.getObjectByName('Game_Landscape'), sampleGround);

  // 开启主树阴影投射，并修复导出树皮中的零长度切线。
  tree.traverse((mesh) => {
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    // 树皮存在零长度切线，着色器归一化时会算出 NaN 并被泛光扩成黑块。
    repairTangents(mesh.geometry);
  });
  const detail = createGroundDetailTexture();
  const plateauMaterial = ground.getObjectByName('Game_Plateau').material;
  ground.traverse((mesh) => {
    if (!mesh.isMesh) return;
    mesh.receiveShadow = true;
    // 两块地形导出时自发光（0.09 与 0.15）和法线贴图强度（0.3 与 1）不同，草色统一后在接缝处会出现明暗分界，这里统一取主平台的值。
    mesh.material.emissive.copy(plateauMaterial.emissive);
    mesh.material.normalScale.copy(plateauMaterial.normalScale);
    // 只有主平台的烘焙贴图画了岩石，远处地面整片按草地绘制。
    applyGroundDetail(mesh.material, { detail, hasRock: mesh.material === plateauMaterial });
  });
  forest.traverse((mesh) => {
    if (!mesh.isMesh) return;
    mesh.material.color.set(0x7195b5);
    mesh.material.emissiveIntensity = 0.32;
  });
  group.updateMatrixWorld(true);
  return { group, ground, tree, quality, sample: sampleGround };
}
