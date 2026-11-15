import { SCENE_LAYOUT } from '../src/world/scene-layout.js';
import { heightAt, canWalkTo } from '../src/world/terrain.js';
import { isOnPaper } from '../src/world/paper.js';
import { TemporalAAPass } from '../src/world/temporal-aa.js';

/** 开发验收：通过 URL 的 inspect 参数检查模型、纸面和出生点。 */
export function inspectScene(app, view) {
  const { THREE, terrain, camera, debug } = app;
  terrain.group.updateMatrixWorld(true);
  const treeMeshes = [];
  terrain.tree.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const box = new THREE.Box3().setFromObject(mesh);
    treeMeshes.push({
      name: mesh.name, visible: mesh.visible, parentVisible: mesh.parent.visible,
      min: box.min.toArray(), max: box.max.toArray(),
      material: mesh.material.name, alphaTest: mesh.material.alphaTest,
      color: mesh.material.color.getHexString(), opacity: mesh.material.opacity,
    });
  });
  const report = {
    quality: terrain.quality,
    flowers: app.daisies.count,
    spawns: ['spawn', 'respawn', 'freeSpawn'].map((key) => ({ key, ...terrain.sample(SCENE_LAYOUT[key].x, SCENE_LAYOUT[key].z) })),
    treeMeshes,
    origin: terrain.sample(0, 0),
  };
  const matrix = new THREE.Matrix4();
  const point = new THREE.Vector3();
  let flowerHeightError = 0;
  let flowersOnPaper = 0;
  for (const mesh of app.daisies.plants) {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      point.setFromMatrixPosition(matrix);
      flowerHeightError = Math.max(flowerHeightError, Math.abs(point.y - heightAt(point.x, point.z) - 0.005));
      if (isOnPaper(point.x, point.z, 0.249)) flowersOnPaper++;
    }
  }
  let blockedRouteSteps = 0;
  for (let z = SCENE_LAYOUT.spawn.z; z > 3; z -= 0.2) {
    if (!canWalkTo(0, z - 0.2, 0, z)) blockedRouteSteps++;
  }
  report.flowerHeightError = flowerHeightError;
  report.flowersOnPaper = flowersOnPaper;
  report.blockedRouteSteps = blockedRouteSteps;
  console.info('SCENE_QA', JSON.stringify(report));
  const top = terrain.sample(0, 0).height;
  const views = {
    side: { pos: [-29, top + 6, 7], look: [0, top + 3, -2] },
    front: { pos: [0, top + 3, 38], look: [-1, top + 8, -7] },
    tree: { pos: [-3, top + 5, 8], look: [-3, top + 5, -6] },
    'flower-field': { pos: [2, top + 1.65, 7], look: [-1.4, top + 1.35, -5] },
    crown: { pos: [14, top + 16, 26], look: [-5, top + 19, -5] },
    trunk: { pos: [-2.9, top + 1.7, -2.6], look: [-5.2, top + 11, -5.4] },
    zenith: { pos: [18, top + 1.65, 18], look: [18, top + 30, 17.95] },
    aurora: { pos: [10, top + 1.65, 11], look: [16, top + 12, -28] },
  };
  if (views[view]) {
    debug.cam = views[view];
    app.items.view.visible = false;
  }
  if (view === 'sweep') checkTreeSweep(app);
  if (view === 'title-check') checkTreeSweep(app, true);
  if (view === 'zenith') checkSkyPixels(app);
  if (view === 'taa-check') checkTemporalPixels(app);
  if (view === 'flowers-check') checkDistantFlowers(app);
  if (view === 'flowers-mid-check') checkDistantFlowers(app, true);
}

/** 用游戏的雏菊和 TAA 比较同一段风摆，镜头固定，排除星点、人物和纸面的变化。 */
function checkDistantFlowers({ THREE, renderer, camera, daisies }, middle = false) {
  const width = 320;
  const height = 180;
  const probe = new THREE.PerspectiveCamera(62, width / height, 0.08, 4000);
  probe.updateMatrixWorld(true);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0);
  scene.add(new THREE.HemisphereLight(0x9db9ed, 0x243b4c, 1.65));
  const columns = middle ? 14 : 24;
  const radii = [2.8, 4.2, 5.7, 7.3];
  const count = columns * radii.length;
  const projection = height / (2 * Math.tan(THREE.MathUtils.degToRad(probe.fov / 2)));
  const original = new THREE.InstancedMesh(daisies.plants[0].geometry, daisies.plants[0].material, count);
  const filtered = new THREE.InstancedMesh(daisies.blooms[0].geometry, daisies.blooms[0].material, 0);
  const pose = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / columns);
    const z = middle ? -0.055 * projection / radii[row] : -8 - row * 4.7 - Math.sin(i * 28) * 0.8;
    const col = i % columns - (columns - 1) / 2;
    const x = (middle ? col * 19 * -z / projection : col * 0.34) + Math.sin(i * 12) * (middle ? 0.025 : 0.08);
    const y = middle ? (32 + row * 36 - height / 2) * -z / projection - 0.133 : -1.67;
    pose.makeScale(0.055, 0.055, 0.055).setPosition(x, y, z);
    original.setMatrixAt(i, pose);
  }
  filtered.instanceMatrix = original.instanceMatrix;
  filtered.count = count;
  original.frustumCulled = filtered.frustumCulled = false;
  scene.add(original, filtered);
  const input = new THREE.WebGLRenderTarget(width, height, {
    depthTexture: new THREE.DepthTexture(width, height, THREE.UnsignedIntType),
  });
  const output = new THREE.WebGLRenderTarget(width, height);
  const previousTarget = renderer.getRenderTarget();
  const taa = new TemporalAAPass(probe);
  taa.setSize(width, height);
  daisies.setProjection(projection);
  function measure(profile) {
    daisies.setCoverageProfile(profile);
    filtered.renderOrder = profile === 2 ? -1 : 1;
    taa.reset();
    let current = new Uint8Array(width * height * 4);
    let previous = current.slice();
    let changes = 0;
    let light = 0;
    const bands = [0, 0, 0, 0];
    for (let i = 0; i < 64; i++) {
      daisies.update(i / 30);
      taa.jitterCamera();
      renderer.setRenderTarget(input);
      renderer.render(scene, probe);
      taa.render(renderer, output, input);
      taa.restoreCamera();
      renderer.readRenderTargetPixels(output, 0, 0, width, height, current);
      if (i >= 8) {
        for (let p = 1; p < current.length; p += 4) {
          const change = Math.abs(current[p] - previous[p]);
          changes += change;
          light += current[p];
          if (middle) {
            const row = Math.floor(p / (width * 4));
            const band = Math.max(0, Math.min(3, Math.floor((row - 11) / 36)));
            bands[band] += change;
          }
        }
      }
      [current, previous] = [previous, current];
    }
    const average = (sum) => Number((sum / (56 * 255)).toFixed(2));
    return { change: average(changes), light: average(light), ...(middle && { bands: bands.map(average) }) };
  }
  const before = measure(middle ? 1 : 0);
  const after = measure(2);
  daisies.setCoverageProfile(2);
  const screen = renderer.getDrawingBufferSize(new THREE.Vector2());
  daisies.setProjection(screen.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))));
  renderer.setRenderTarget(previousTarget);
  for (const item of [input, output, taa, original, filtered]) item.dispose();
  document.title = `${middle ? '中景' : '远景'}雏菊检查：亮度波动 ${before.change} → ${after.change}`;
  console.info('FLOWERS_QA', JSON.stringify({ middle, before, after }));
}

/** 同一条慢移路径比较细线总亮度的波动，并检查移开细线后是否还残留亮点。 */
function checkTemporalPixels({ THREE, renderer }) {
  const [width, height] = [96, 64];
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0);
  const camera = new THREE.PerspectiveCamera(46, width / height, 0.08, 4000);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const shape = new THREE.PlaneGeometry(0.023, 1.5);
  const lines = new THREE.Group();
  for (let i = -5; i <= 5; i++) {
    const line = new THREE.Mesh(shape, material);
    line.position.set(i * 0.23, 0, -i * 0.011);
    line.rotation.z = 0.035 + (i % 3) * 0.02;
    lines.add(line);
  }
  scene.add(lines);
  const input = new THREE.WebGLRenderTarget(width, height, {
    depthTexture: new THREE.DepthTexture(width, height, THREE.UnsignedIntType),
  });
  const output = new THREE.WebGLRenderTarget(width, height);
  const taa = new TemporalAAPass(camera);
  const previousTarget = renderer.getRenderTarget();
  taa.setSize(width, height);
  function measure(history, i) {
    camera.position.set(i * 0.012, 0, 3);
    camera.updateMatrixWorld(true);
    if (history) taa.jitterCamera();
    renderer.setRenderTarget(input);
    renderer.render(scene, camera);
    if (history) {
      taa.render(renderer, output, input);
      taa.restoreCamera();
    }
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(history ? output : input, 0, 0, width, height, pixels);
    let light = 0;
    for (let p = 0; p < pixels.length; p += 4) light += pixels[p] / 255;
    return light;
  }
  function swing(history) {
    const values = Array.from({ length: 40 }, (_, i) => measure(history, i)).slice(8);
    const change = values.slice(1).reduce((total, value, i) => total + Math.abs(value - values[i]), 0);
    return Number((change / (values.length - 1)).toFixed(2));
  }
  const off = swing(false);
  const temporal = swing(true);
  lines.visible = false;
  const ghost = measure(true, 39);
  renderer.setRenderTarget(previousTarget);
  for (const item of [input, output, taa, material, shape]) item.dispose();
  const report = { off, temporal, ghost };
  document.title = `稳像检查：亮度波动 ${off} → ${temporal}，残影 ${ghost}`;
  console.info('TAA_QA', JSON.stringify(report));
}

/** 单独绘制天穹，检查天顶覆盖和极光随时间变化，不把星点或树叶算进去。 */
function checkSkyPixels({ THREE, renderer, sky }) {
  const scene = new THREE.Scene();
  const dome = sky.group.getObjectByName('sky-dome').clone();
  scene.add(dome);
  const probe = new THREE.PerspectiveCamera(60, 1.5, 0.1, 4000);
  const target = new THREE.WebGLRenderTarget(96, 64);
  const previousTarget = renderer.getRenderTarget();
  const clock = dome.material.uniforms.uAuroraTime;
  const previousTime = clock.value;
  function capture(look, time) {
    clock.value = time;
    probe.lookAt(...look);
    renderer.setRenderTarget(target);
    renderer.render(scene, probe);
    const pixels = new Uint8Array(96 * 64 * 4);
    renderer.readRenderTargetPixels(target, 0, 0, 96, 64, pixels);
    return pixels;
  }
  const overhead = capture([0, 1, 0], 0);
  const first = capture([0, 0.29, -1], 0);
  const second = capture([0, 0.29, -1], 12);
  let black = 0;
  let moving = 0;
  for (let i = 0; i < overhead.length; i += 4) {
    if (overhead[i] + overhead[i + 1] + overhead[i + 2] === 0) black++;
    if (Math.abs(first[i + 1] - second[i + 1]) + Math.abs(first[i + 2] - second[i + 2]) > 2) moving++;
  }
  clock.value = previousTime;
  renderer.setRenderTarget(previousTarget);
  target.dispose();
  console.info('SKY_QA', JSON.stringify({ black, moving, pixels: 96 * 64 }));
  document.title = `天空检查：天顶 ${black} 黑像素，极光 ${moving} 像素变化`;
}

/** 检查标题镜头或树旁扫视；采样的是屏幕使用的画布。 */
function checkTreeSweep({ display: canvas, debug, terrain, story }, title = false) {
  const { tree } = SCENE_LAYOUT;
  const poses = [[-1.2, 7.5], [-3.5, 1.5], [-2, -4], [-7.8, -2], [3, -4], [0, 17]];
  const look = [tree.x, 0, tree.z];
  const sample = document.createElement('canvas');
  sample.width = 96;
  sample.height = 54;
  const ctx = sample.getContext('2d', { willReadFrequently: true });
  const framesPerPose = 24;
  const total = title ? 180 : poses.length * framesPerPose;
  let frame = 0;
  let blackFrames = 0;
  const started = performance.now();
  function pose() {
    const [x, z] = poses[Math.floor(frame / framesPerPose)];
    const t = (frame % framesPerPose) / (framesPerPose - 1);
    look[0] = tree.x + Math.sin(t * Math.PI * 2) * 4;
    look[1] = 15 + t * 16;
    debug.cam = { pos: [x, terrain.sample(x, z).height + 1.66, z], look };
  }
  if (!title) pose();
  debug.afterFrame = () => {
    if (title ? story.state.mode !== 'title' : story.state.mode === 'title') return;
    ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
    const pixels = ctx.getImageData(0, 0, sample.width, sample.height).data;
    const dark = (x, y) => {
      const i = (y * sample.width + x) * 4;
      return pixels[i] <= 1 && pixels[i + 1] <= 1 && pixels[i + 2] <= 1;
    };
    // 只统计至少 16×12 个采样点的全黑矩形，不把暗色树叶或画面边缘当黑块。
    let found = false;
    for (let y = 0; y < sample.height - 11 && !found; y++) {
      for (let x = 0; x < sample.width - 15 && !found; x++) {
        if (!dark(x, y) || !dark(x + 15, y + 11)) continue;
        let n = 0;
        for (let dy = 0; dy < 12; dy++) {
          for (let dx = 0; dx < 16; dx++) if (dark(x + dx, y + dy)) n++;
        }
        found = n === 192;
      }
    }
    if (found) blackFrames++;
    if (++frame < total) {
      if (!title) pose();
    } else {
      debug.afterFrame = null;
      if (!title) debug.cam = null;
      const [width, height] = [canvas.width, canvas.height];
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      document.title = `${title ? '标题' : '树旁'}检查：${frame} 帧，${blackFrames} 帧黑块（${width}×${height}）`;
      console.info('SCENE_FRAMES', JSON.stringify({ title, frames: frame, blackFrames, width, height, seconds }));
    }
  };
}
