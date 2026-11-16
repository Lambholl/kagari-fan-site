import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createSurfaceSampler } from './surface.js';
import { SCENE_LAYOUT } from './scene-layout.js';
import { repairTangents } from './tangents.js';
import { trackLoad } from '../loading.js';

/** 世界原点处山顶地面的基准高度（米）。 */
export const HILL_TOP = 14;
let sampleGround;

/** 当前可见地面的高度（米），须在场景加载后调用，网格外返回 NaN。 */
export function heightAt(x, z) {
  return sampleGround(x, z)?.height ?? NaN;
}

/** 返回可种花的主平台平地或缓坡信息，悬崖、外围林地和树根附近返回 null。 */
export function flowerSurfaceAt(x, z) {
  const surface = sampleGround(x, z);
  if (!surface || !surface.plateau || surface.normalY < 0.9) return null;
  if (Math.hypot(x - SCENE_LAYOUT.tree.x, z - SCENE_LAYOUT.tree.z) < 0.9) return null;
  return surface;
}

/** 检查一步移动是否符合地面坡度、高度差及主树避让约束，须在场景加载后调用。 */
export function canWalkTo(x, z, fromX, fromZ) {
  const surface = sampleGround(x, z);
  if (!surface || surface.normalY < 0.78) return false;
  const step = Math.abs(surface.height - heightAt(fromX, fromZ));
  if (step > 0.22 + Math.hypot(x - fromX, z - fromZ) * 0.65) return false;
  return Math.hypot(x - SCENE_LAYOUT.tree.x, z - SCENE_LAYOUT.tree.z) >= SCENE_LAYOUT.tree.radius;
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

  // 开启主树阴影投射，并修复导出树皮中的零长度切线。
  tree.traverse((mesh) => {
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    // 树皮存在零长度切线，着色器归一化时会算出 NaN 并被泛光扩成黑块。
    repairTangents(mesh.geometry);
  });
  ground.traverse((mesh) => {
    if (mesh.isMesh) mesh.receiveShadow = true;
  });
  forest.traverse((mesh) => {
    if (!mesh.isMesh) return;
    mesh.material.color.set(0x7195b5);
    mesh.material.emissiveIntensity = 0.32;
  });
  group.updateMatrixWorld(true);
  return { group, ground, tree, quality, sample: sampleGround };
}
