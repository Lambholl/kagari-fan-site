import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createSurfaceSampler } from './surface.js';
import { SCENE_LAYOUT } from './scene-layout.js';
import { repairTangents } from './tangents.js';

export const HILL_TOP = 14;
let sampleGround;

/** 当前可见地面的高度；必须在场景加载后调用。 */
export function heightAt(x, z) {
  return sampleGround(x, z)?.height ?? NaN;
}

/** 花只种在主平台的平地和缓坡上，悬崖及外围林地不种花。 */
export function flowerSurfaceAt(x, z) {
  const surface = sampleGround(x, z);
  if (!surface || !surface.plateau || surface.normalY < 0.9) return null;
  if (Math.hypot(x - SCENE_LAYOUT.tree.x, z - SCENE_LAYOUT.tree.z) < 0.9) return null;
  return surface;
}

/** 检查每一步的高度差和坡度，阻止跨越崖沿，并允许沿崖边滑动。 */
export function canWalkTo(x, z, fromX, fromZ) {
  const surface = sampleGround(x, z);
  if (!surface || surface.normalY < 0.78) return false;
  const step = Math.abs(surface.height - heightAt(fromX, fromZ));
  if (step > 0.22 + Math.hypot(x - fromX, z - fromZ) * 0.65) return false;
  return Math.hypot(x - SCENE_LAYOUT.tree.x, z - SCENE_LAYOUT.tree.z) >= SCENE_LAYOUT.tree.radius;
}

/** 加载本地缓坡场景。主平台、外围地形、主树和树林保留各自的网格。 */
export async function createTerrain({ mobile = false } = {}) {
  const quality = mobile ? 'mobile' : 'desktop';
  const loader = new GLTFLoader();
  const load = async (name) => (await loader.loadAsync(`${import.meta.env.BASE_URL}scene-assets/${name}.glb`)).scene;
  const [ground, tree, forest] = await Promise.all([
    load(`ground-${quality}`), load(`tree-game-${quality}`),
    load(`forest-${quality}`),
  ]);
  const group = new THREE.Group();
  group.name = 'terrain';
  group.rotation.y = SCENE_LAYOUT.yaw;
  group.position.set(SCENE_LAYOUT.offsetX, HILL_TOP, SCENE_LAYOUT.offsetZ);
  // 主树已在 Blender 中应用场景比例，只缩放地形和外围树林。
  const landscape = new THREE.Group();
  landscape.scale.setScalar(SCENE_LAYOUT.scale);
  landscape.add(ground, forest);
  group.add(landscape, tree);
  group.updateMatrixWorld(true);
  const originalSampler = createSurfaceSampler(ground);
  // 篝仍以世界原点为交互中心，整套场景只做一次统一平移与旋转。
  group.position.y += HILL_TOP - originalSampler(0, 0).height;
  group.updateMatrixWorld(true);
  sampleGround = createSurfaceSampler(ground);

  // 主树使用 Blender 中简化并导出的模型，游戏端不更改其网格或材质。
  tree.traverse((mesh) => {
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    // 导出的树皮有零长度切线，着色时会算出 NaN 并被泛光扩成黑块；这里只修坏掉的顶点。
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
