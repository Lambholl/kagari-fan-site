import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSurfaceSampler } from '../src/world/surface.js';
import { SCENE_LAYOUT } from '../src/world/scene-layout.js';
import { SHEETS, isOnPaper } from '../src/world/paper.js';
import { scenePixelRatio } from '../src/world/presentation.js';
import { repairTangents } from '../src/world/tangents.js';
import { SCENE_ASSET_DIR, SOURCE_TREE_DIR, SCENE_FILES, SKY_TEXTURES } from '../scripts/scene-assets.js';
import { createSkyDome } from '../src/world/sky-dome.js';
import { TemporalAAPass, TEMPORAL_SAMPLES } from '../src/world/temporal-aa.js';
import { loadGeometry } from './glb-geometry.js';

test('高度采样包含父节点的旋转、缩放和平移，并排除网格外位置', () => {
  const root = new THREE.Group();
  root.position.set(3, 7, -4);
  root.scale.setScalar(2);
  root.rotation.y = Math.PI / 2;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2));
  plane.name = 'Game_Plateau';
  root.add(plane);
  const sample = createSurfaceSampler(root);
  assert.equal(sample(3, -4).height, 7);
  assert.equal(sample(3, -4).plateau, true);
  assert.equal(sample(100, 100), null);
});

test('上下重叠处选择可见的上表面，不把岩壁当平地', () => {
  const root = new THREE.Group();
  for (const y of [0, 5]) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2));
    mesh.position.y = y;
    mesh.name = y === 5 ? 'Game_Plateau' : 'Game_Landscape';
    root.add(mesh);
  }
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(2, 20));
  root.add(wall);
  const sample = createSurfaceSampler(root);
  assert.equal(sample(0, 0).height, 5);
  assert.equal(sample(0, 0, true).height, 5);
});

const groundPath = `${SCENE_ASSET_DIR}ground-mobile.glb`;
test('封闭天穹覆盖天顶、地平线和下方，远景只使用无极光贴图', () => {
  const dome = createSkyDome(new THREE.Texture(), 1500, new THREE.Vector3(0, 0, -1), 0.2);
  const ray = new THREE.Raycaster();
  // 射线稍微避开三角面共边；正天顶由浏览器像素检查覆盖。
  for (const pitch of [-89.9, -45.2, 0.2, 45.2, 52, 70, 89.9]) {
    const angle = THREE.MathUtils.degToRad(pitch);
    for (let yaw = 0.017; yaw < 2 * Math.PI; yaw += Math.PI / 8) {
      ray.ray.direction.set(Math.cos(angle) * Math.sin(yaw), Math.sin(angle), Math.cos(angle) * Math.cos(yaw));
      assert.ok(ray.intersectObject(dome).length, `天穹缺面：仰角 ${pitch}°、朝向 ${yaw}`);
    }
  }
  assert.ok(SCENE_FILES.every((file) => !file.startsWith('backdrop')));
  assert.deepEqual([...SKY_TEXTURES.keys()], ['sky-no-aurora-mobile.jpg', 'sky-no-aurora-desktop.jpg']);
  for (const path of SKY_TEXTURES.values()) {
    if (existsSync(path)) assert.equal(readFileSync(path).readUInt16BE(0), 0xffd8);
  }
});

test('大窗口和高分屏使用有限的渲染像素，不改变画面宽高比', () => {
  assert.equal(scenePixelRatio(1280, 720, 1, true), 1);
  assert.equal(scenePixelRatio(1920, 1080, 2, true), 1);
  const wide = scenePixelRatio(3606, 1868, 1.75, true);
  assert.ok(wide < 1);
  assert.ok(Math.floor(3606 * wide) * Math.floor(1868 * wide) <= 1920 * 1080);
  assert.equal(scenePixelRatio(1920, 1080, 2, false), 4 / 3);
});

test('时序采样不偏离像素中心，且切镜头或改变尺寸会清空历史', () => {
  const camera = new THREE.PerspectiveCamera(62, 1.5, 0.08, 4000);
  camera.updateMatrixWorld(true);
  const pass = new TemporalAAPass(camera);
  pass.setSize(1280, 720);
  const initial = camera.projectionMatrix.clone();
  const offsets = new Set();
  const mean = new THREE.Vector2();
  for (const [x, y] of TEMPORAL_SAMPLES) {
    mean.add(new THREE.Vector2(x, y));
    assert.ok(Math.abs(x) < 0.5 && Math.abs(y) < 0.5);
    pass.jitterCamera();
    offsets.add(camera.projectionMatrix.elements.slice(8, 10).join(','));
    pass.restoreCamera();
    assert.ok(camera.projectionMatrix.equals(initial));
  }
  assert.equal(offsets.size, 8);
  assert.equal(mean.lengthSq(), 0);
  pass.uniforms.uHasHistory.value = true;
  camera.position.z = 10;
  camera.updateMatrixWorld(true);
  pass.jitterCamera();
  assert.equal(pass.uniforms.uHasHistory.value, false);
  pass.restoreCamera();
  pass.uniforms.uHasHistory.value = true;
  pass.setSize(1000, 600);
  assert.equal(pass.uniforms.uHasHistory.value, false);
  pass.dispose();
});

test('实际场景：纸张完整处于椭圆台顶，出生点和上坡路线连续', { skip: !existsSync(groundPath) }, async () => {
  const ground = await loadGeometry(groundPath);
  ground.rotation.y = SCENE_LAYOUT.yaw;
  ground.scale.setScalar(SCENE_LAYOUT.scale);
  ground.position.set(SCENE_LAYOUT.offsetX, 14, SCENE_LAYOUT.offsetZ);
  let sample = createSurfaceSampler(ground);
  ground.position.y += 14 - sample(0, 0).height;
  sample = createSurfaceSampler(ground);
  assert.equal(sample(0, 0).height, 14);
  const sheet = SHEETS[0];
  for (let x = -sheet.w / 2; x <= sheet.w / 2; x += 0.2) {
    for (let z = -sheet.h / 2; z <= sheet.h / 2; z += 0.2) {
      const wx = sheet.cx + x * Math.cos(sheet.rot) + z * Math.sin(sheet.rot);
      const wz = sheet.cz - x * Math.sin(sheet.rot) + z * Math.cos(sheet.rot);
      const surface = sample(wx, wz, true);
      assert.ok(surface && surface.normalY > 0.98, `纸下必须是平缓台面：${wx}, ${wz}`);
      assert.ok(isOnPaper(wx, wz, 0.001));
    }
  }
  for (const key of ['spawn', 'respawn', 'freeSpawn']) {
    const { x, z } = SCENE_LAYOUT[key];
    assert.ok(sample(x, z)?.plateau);
    assert.ok(sample(x, z).normalY > 0.98);
  }
  for (let z = SCENE_LAYOUT.spawn.z; z > 3; z -= 0.2) {
    const current = sample(0, z);
    const next = sample(0, z - 0.2);
    assert.ok(next.plateau && next.normalY > 0.98);
    assert.ok(Math.abs(current.height - next.height) < 0.06);
  }
  // 与 Three.js 原生射线相交结果比对，避免显示地面与行走高度出现差别。
  const ray = new THREE.Raycaster();
  for (let z = -8; z < 95; z += 4.3) {
    ray.set(new THREE.Vector3(0, 200, z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(ground, true)[0];
    assert.ok(Math.abs(sample(0, z).height - hit.point.y) < 0.0001);
  }
});

test('只发布选定的物件，两档主树保留材质、场景比例及主要枝干', { skip: !existsSync(`${SOURCE_TREE_DIR}tree-game-mobile.glb`) }, async () => {
  assert.ok(!SCENE_FILES.some((name) => name.startsWith('meadow-') || name.startsWith('scene-')));
  for (const name of SCENE_FILES) {
    const file = `${name.startsWith('tree-') ? SOURCE_TREE_DIR : SCENE_ASSET_DIR}${name}`;
    const data = readFileSync(file);
    assert.equal(data.toString('ascii', 0, 4), 'glTF');
    assert.equal(data.readUInt32LE(8), data.length);
    if (name.startsWith('tree-game')) {
      const json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)));
      const triangleLimit = name.includes('mobile') ? 78000 : 90000;
      let triangles = 0;
      assert.equal(json.meshes.length, 1);
      assert.equal(json.meshes[0].primitives.length, 2);
      for (const primitive of json.meshes[0].primitives) {
        const material = json.materials[primitive.material];
        triangles += json.accessors[primitive.indices].count / 3;
        assert.ok(primitive.attributes.TEXCOORD_0 !== undefined);
        assert.ok(primitive.attributes.NORMAL !== undefined);
        assert.equal(material.doubleSided, true);
        assert.equal(material.alphaMode ?? 'OPAQUE', material.name.includes('Leaf') ? 'MASK' : 'OPAQUE');
      }
      assert.ok(triangles <= triangleLimit, `${name} 应在 ${triangleLimit} 三角面以内`);
      const tree = await loadGeometry(file);
      const bounds = new THREE.Box3().setFromObject(tree, true);
      assert.ok(Math.abs(bounds.min.y) < 0.05 * SCENE_LAYOUT.scale, '树根须与导出地面对齐');
      assert.ok(bounds.max.y > 7 * SCENE_LAYOUT.scale && bounds.max.y < 7.3 * SCENE_LAYOUT.scale, '主树须在 Blender 中对齐场景比例');
      const barkIndex = json.meshes[0].primitives.findIndex((p) => json.materials[p.material].name.includes('Bark'));
      const meshes = [];
      tree.traverse((mesh) => { if (mesh.isMesh) meshes.push(mesh); });
      assertBarkConnected(meshes[barkIndex]);
    }
  }
});

test('零长度切线被修成与法线垂直的单位向量，正常切线保持不变', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 1, 0, 0, 0, 0, 1], 3));
  geometry.setAttribute('tangent', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 1, 0, -1, NaN, 0, 0, 1], 4));
  assert.equal(repairTangents(geometry), 2);
  const tangent = geometry.attributes.tangent;
  const normal = geometry.attributes.normal;
  for (const i of [0, 2]) {
    const t = new THREE.Vector3().fromBufferAttribute(tangent, i);
    const n = new THREE.Vector3().fromBufferAttribute(normal, i);
    assert.ok(Math.abs(t.length() - 1) < 1e-6);
    assert.ok(Math.abs(t.dot(n)) < 1e-6);
  }
  assert.deepEqual([tangent.getX(1), tangent.getY(1), tangent.getZ(1), tangent.getW(1)], [0, 1, 0, -1]);
  assert.equal(tangent.getW(0), 1);
  assert.equal(repairTangents(new THREE.BufferGeometry()), 0);
});

test('两档主树修复后不再有零长度切线', { skip: !existsSync(`${SOURCE_TREE_DIR}tree-game-mobile.glb`) }, async () => {
  for (const name of ['tree-game-desktop.glb', 'tree-game-mobile.glb']) {
    const tree = await loadGeometry(`${SOURCE_TREE_DIR}${name}`);
    tree.traverse((mesh) => {
      if (!mesh.isMesh) return;
      repairTangents(mesh.geometry);
      const tangent = mesh.geometry.attributes.tangent;
      for (let i = 0; i < tangent.count; i++) {
        const length = Math.hypot(tangent.getX(i), tangent.getY(i), tangent.getZ(i));
        assert.ok(Math.abs(length - 1) < 0.01, `${name} 的第 ${i} 个切线长度为 ${length}`);
      }
    });
  }
});

/** 忽略 UV 接缝产生的重合顶点，确认木质网格主体没有大段断开。 */
function assertBarkConnected(mesh) {
  const original = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  for (const key of Object.keys(original.attributes)) {
    if (key !== 'position') original.deleteAttribute(key);
  }
  const geometry = mergeVertices(original, 0.0001);
  const count = geometry.attributes.position.count;
  const parent = Int32Array.from({ length: count }, (_, index) => index);
  const groups = new Uint32Array(count);
  function root(index) {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  }
  const indices = geometry.index.array;
  for (let i = 0; i < indices.length; i += 3) {
    const first = root(indices[i]);
    parent[root(indices[i + 1])] = first;
    parent[root(indices[i + 2])] = first;
  }
  for (let i = 0; i < count; i++) groups[root(i)]++;
  assert.ok(Math.max(...groups) >= count * 0.97, '两根主要断枝须与树身连在一起');
}
