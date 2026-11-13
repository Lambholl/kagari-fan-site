/**
 * 运行 `node scripts/calculate-earth-view.js`，检查固定月面场景的地球朝向和贴图覆盖范围。
 * 输出 JSON 格式的观测角度及检查结果，检查失败时以退出码 1 结束。
 * 计算采用固定自转相位和理想潮汐锁定模型，忽略具体日期的天平动。
 * 参考：https://science.nasa.gov/resource/earth-and-sun-from-the-moons-south-pole/
 * 参考：https://ntrs.nasa.gov/api/citations/20210010030/downloads/HLS-UG-001%20Lunar%20Thermal%20Analysis%20Guidebook%20Baseline_STI.pdf
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MOON_DIR } from '../src/world/sky.js';
import { calculateEarthView } from '../src/world/earth-view.js';

const view = calculateEarthView(MOON_DIR);
const { quaternion, ...angles } = view;
const radians = THREE.MathUtils.degToRad;
const center = new THREE.Vector3(
  Math.cos(radians(view.longitudeDeg)) * Math.cos(radians(view.latitudeDeg)),
  Math.sin(radians(view.latitudeDeg)),
  -Math.sin(radians(view.longitudeDeg)) * Math.cos(radians(view.latitudeDeg)),
).applyQuaternion(quaternion);
assert.ok(center.distanceTo(MOON_DIR.clone().negate()) < 1e-10, '可见面的中心应朝向观察者');
assert.ok(Math.abs(view.poleSeparationDeg - 23.44) < 1e-10, '两颗天体的北轴应满足选定夹角');
assert.ok(Math.abs(quaternion.length() - 1) < 1e-10, '旋转应保持球体形状');

// 近处的大球只有小于半球的表面可见，因此用实际渲染的角半径检查裁剪。
const angularRadiusDeg = 10.5;
const minimumVisibleLatitudeDeg = view.latitudeDeg - (90 - angularRadiusDeg);
const textureMinimumLatitudeDeg = -90 + 180 * (64 / 512);
assert.ok(minimumVisibleLatitudeDeg > textureMinimumLatitudeDeg, '裁剪后的贴图应覆盖整个可见面');
console.log(JSON.stringify({
  model: '理想潮汐锁定、固定自转相位；忽略天平动',
  ...angles,
  minimumVisibleLatitudeDeg,
  textureMinimumLatitudeDeg,
  checks: '中心朝向、两轴夹角、旋转长度和贴图覆盖检查通过',
}, null, 2));
