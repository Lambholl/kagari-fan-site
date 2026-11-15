import { SCENE_LAYOUT } from '../src/world/scene-layout.js';
import { heightAt, canWalkTo } from '../src/world/terrain.js';
import { isOnPaper } from '../src/world/paper.js';

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
  for (const mesh of app.daisies.group.children) {
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
