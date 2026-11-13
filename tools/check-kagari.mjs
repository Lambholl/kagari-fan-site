// 先启动开发服务器。Playwright 可通过 PLAYWRIGHT_MODULE 指定已有安装路径。
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve(process.env.QA_OUTPUT || '.materials/qa-cg');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().startsWith('Failed to load resource:')) errors.push(m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`${r.status()} ${r.url()}`);
});

try {
  await page.goto(process.env.QA_URL || 'http://127.0.0.1:5173');
  await page.waitForFunction(() => window.__kagari, { timeout: 30000 });
  await page.evaluate(() => {
    const a = window.__kagari;
    a.story.state.mode = 'play';
    a.story.state.busy = true;
    a.player.state.active = false;
    a.kagari.state.nextBlink = 10000;
    document.querySelectorAll('body > :not(#app):not(script)').forEach((e) => { e.style.display = 'none'; });
  });

  async function capture(name, pos, look, raised = 0, expression = 'neutral') {
    await page.evaluate(({ pos, look, raised, expression }) => {
      const a = window.__kagari;
      const world = (p) => a.kagari.group.localToWorld(new a.THREE.Vector3(...p)).toArray();
      a.debug.cam = { pos: world(pos), look: world(look) };
      a.kagari.setLook(raised);
      a.kagari.setExpression(expression);
    }, { pos, look, raised, expression });
    await page.waitForTimeout(2200);
    await page.screenshot({ path: resolve(output, `${name}.png`) });
  }

  const front = [0.45, 0.94, 0.95];
  const center = [0, 0.37, 0.02];
  const details = await page.evaluate(() => {
    const a = window.__kagari;
    const clips = [];
    const backTies = [];
    a.kagari.group.traverse((m) => {
      if (!m.isMesh || m.name === 'outline') return;
      if (/^Stepped_hair_clip/.test(m.name) && m.visible) clips.push(m.name);
      if (/^Back_tie/.test(m.name) && m.visible) backTies.push(m.name);
    });
    const heights = [];
    for (const x of [-0.12, -0.08, 0.08, 0.12]) {
      for (const z of [-0.24, -0.28, -0.32]) heights.push(a.kagari.clothHeightAt(x, z));
    }
    return { wristRibbons: a.ribbons.group.children.length, clips, backTies, rearDrapeMax: Math.max(...heights) };
  });
  assert.equal(details.wristRibbons, 5, '出现了腕带以外的额外长带');
  assert.equal(details.clips.length, 4, '原模型的发夹未保留完整');
  assert.equal(details.backTies.length, 0, '后领仍有悬空黑带');
  assert(details.rearDrapeMax < 0.18, '裙子后方被鞋子顶起');
  await capture('work-a', front, center);
  await capture('look-b', front, center, 1, 'stare');
  const tracing = await page.evaluate(() => window.__kagari.kagari.state.traceT);
  await page.waitForTimeout(800);
  const tracingAfter = await page.evaluate(() => window.__kagari.kagari.state.traceT);
  assert(tracingAfter - tracing < 0.002, '回望时仍在描画');

  await capture('smile', front, center, 1, 'smile');
  const mouthJoy = await page.evaluate(() => {
    let max = 0;
    window.__kagari.kagari.group.traverse((m) => {
      const i = m.morphTargetDictionary?.Fcl_MTH_Joy;
      if (i !== undefined) max = Math.max(max, m.morphTargetInfluences[i]);
    });
    return max;
  });
  assert(mouthJoy < 0.001, '微笑使用了张嘴笑的形态键');
  await capture('back-left', [-0.65, 1.12, -0.95], [0, 0.26, -0.08]);
  await capture('back-right', [0.65, 1.12, -0.95], [0, 0.26, -0.08]);

  // 从每个鞋顶点上方向下检查遮挡，腰口内部由身体和上衣遮住。
  const coverage = await page.evaluate(() => {
    const a = window.__kagari;
    const T = a.THREE;
    const root = a.kagari.group;
    root.updateMatrixWorld(true);
    const shoes = [];
    const cover = [...a.kagari.seatedSkirt];
    root.traverse((m) => {
      if (!m.isSkinnedMesh || m.name === 'outline') return;
      if (/Shoes/.test(m.material.name)) shoes.push(m);
      if (/^Body001$|^Bodice_/.test(m.name)) {
        m.raycast = T.SkinnedMesh.prototype.raycast;
        m.skeleton.update();
        cover.push(m);
      }
    });
    const p = new T.Vector3();
    const origin = new T.Vector3();
    const ray = new T.Raycaster();
    const down = new T.Vector3(0, -1, 0);
    let tested = 0;
    let belowPaper = 0;
    let highestShoe = -Infinity;
    const uncovered = [];
    for (const m of shoes) {
      m.skeleton.update();
      for (let i = 0; i < m.geometry.attributes.position.count; i++) {
        m.getVertexPosition(i, p);
        m.localToWorld(p);
        const localY = root.worldToLocal(p.clone()).y;
        if (localY < 0) belowPaper++;
        highestShoe = Math.max(highestShoe, localY);
        ray.set(origin.copy(p).addScaledVector(T.Object3D.DEFAULT_UP, 1), down);
        const hit = ray.intersectObjects(cover, false)[0];
        tested++;
        if (!hit || hit.point.y < p.y + 0.002) uncovered.push(root.worldToLocal(p.clone()).toArray());
      }
    }
    for (const m of cover) if (m.isSkinnedMesh) m.raycast = () => {};
    return { tested, uncovered, belowPaper, highestShoe };
  });
  assert.equal(coverage.uncovered.length, 0, `鞋子仍有 ${coverage.uncovered.length} 个顶点穿出`);

  for (const side of ['L', 'R']) {
    await page.evaluate((side) => {
      const a = window.__kagari;
      const p = a.kagari.group.localToWorld(new a.THREE.Vector3(side === 'L' ? 0.2 : -0.2, 0.36, 0.5));
      a.kagari.setReach(side, 1, p);
    }, side);
    await capture(`reach-${side}`, front, center, 1, 'stare');
    await page.evaluate((side) => window.__kagari.kagari.setReach(side, 0), side);
  }
  const shading = await page.evaluate(() => {
    const materials = new Set();
    window.__kagari.kagari.group.traverse((m) => {
      if (m.isMesh && m.visible && m.material.userData.characterProfile) materials.add(m.material);
    });
    const profiles = {};
    let emissiveMaterials = 0;
    let hardRamps = 0;
    for (const m of materials) {
      const name = m.userData.characterProfile;
      profiles[name] = (profiles[name] || 0) + 1;
      if (m.emissive.getHex() !== 0) emissiveMaterials++;
      if (m.gradientMap) hardRamps++;
    }
    return { profiles, emissiveMaterials, hardRamps };
  });
  assert.equal(shading.emissiveMaterials, 0, '角色仍使用自发光提亮');
  assert.equal(shading.hardRamps, 0, '角色仍使用硬切明暗贴图');
  for (const profile of ['skin', 'detail', 'hair', 'cloth', 'frill', 'ribbon']) {
    assert(shading.profiles[profile] > 0, `缺少 ${profile} 材质分区`);
  }
  await page.evaluate(() => {
    const a = window.__kagari;
    a.camera.fov = 35;
    a.camera.updateProjectionMatrix();
  });
  await capture('face-close', [0.3, 0.79, 0.75], [0, 0.59, 0.13], 1, 'stare');
  const faceDetails = await page.evaluate(() => {
    const a = window.__kagari;
    const root = a.kagari.group;
    const face = root.getObjectByName('Face_4');
    const mouth = root.getObjectByName('Face_1');
    const mouthWeights = () => Object.fromEntries(Object.entries(face.morphTargetDictionary)
      .filter(([name]) => name.startsWith('Fcl_MTH'))
      .map(([name, i]) => [name, face.morphTargetInfluences[i]]));
    const beforeBlink = mouthWeights();
    const previousBlink = a.kagari.state.blink;
    a.kagari.state.blink = 0.5;
    a.kagari.update(0, 0, a.camera.position);
    const duringBlink = mouthWeights();
    a.kagari.state.blink = previousBlink;
    const outlines = [];
    root.traverse((m) => {
      if (m.name === 'outline' && m.userData.outlineSource) {
        outlines.push({ source: m.userData.outlineSource, width: m.userData.outlineWidth,
          followsFace: m.userData.outlineSource === face.name ? m.morphTargetInfluences === face.morphTargetInfluences : null });
      }
    });
    return { beforeBlink, duringBlink, mouthColor: mouth.material.color.getHexString(), outlines };
  });
  assert.deepEqual(faceDetails.beforeBlink, faceDetails.duringBlink, '眨眼改变了嘴型');
  assert(faceDetails.beforeBlink.Fcl_MTH_Close > 0.999, '默认嘴型未闭合');
  assert(faceDetails.beforeBlink.Fcl_MTH_A < 0, '默认嘴型仍在张口');
  assert.notEqual(faceDetails.mouthColor, 'ffffff', '口腔仍有白色露齿效果');
  assert(faceDetails.outlines.some((o) => o.source === 'Hair' && o.width >= 0.001), '头发描边过细');
  assert(faceDetails.outlines.some((o) => o.followsFace), '脸部描边未跟随表情');
  assert(faceDetails.outlines.some((o) => /Overskirt.*seated$/.test(o.source)), '缺少外裙描边');
  await capture('face-neutral', [0.3, 0.79, 0.75], [0, 0.59, 0.13], 0, 'neutral');
  const neutralMouth = await page.evaluate(() => window.__kagari.kagari.state.expr);
  for (const [key, weight] of Object.entries(faceDetails.beforeBlink)) {
    if (key in neutralMouth) assert(Math.abs(neutralMouth[key] - weight) < 0.000001, '看纸和回望改变了闭嘴姿势');
  }
  await page.evaluate(() => {
    const a = window.__kagari;
    a.camera.fov = 62;
    a.camera.updateProjectionMatrix();
  });
  await capture('player-standing', [0.5, 1.66, 1.3], [0, 0.42, 0.08], 1, 'stare');
  const lipGeometry = await page.evaluate(() => {
    const a = window.__kagari;
    const T = a.THREE;
    const face = a.kagari.group.getObjectByName('Face_4');
    const geometry = face.geometry;
    const positions = geometry.attributes.position;
    const neutral = geometry.morphAttributes.position[face.morphTargetDictionary.Fcl_MTH_Neutral];
    const shape = new T.Box3();
    const projected = new T.Box3();
    const p = new T.Vector3();
    const delta = new T.Vector3();
    face.skeleton.update();
    // Neutral 形态键直接影响的顶点围出唇缘，检查其宽度和前后体积。
    for (let i = 0; i < positions.count; i++) {
      if (Math.hypot(neutral.getX(i), neutral.getY(i), neutral.getZ(i)) <= 0.001) continue;
      p.fromBufferAttribute(positions, i);
      face.morphTargetInfluences.forEach((weight, j) => {
        if (weight) p.addScaledVector(delta.fromBufferAttribute(geometry.morphAttributes.position[j], i), weight);
      });
      shape.expandByPoint(p);
      face.getVertexPosition(i, p);
      face.localToWorld(p).project(a.camera);
      p.x = (p.x + 1) * innerWidth / 2;
      p.y = (1 - p.y) * innerHeight / 2;
      projected.expandByPoint(p);
    }
    const size = shape.getSize(new T.Vector3());
    return { width: size.x, depth: size.z, standingWidthPixels: projected.getSize(new T.Vector3()).x };
  });
  assert(lipGeometry.width > 0.007, '唇线缩得过小');
  assert(lipGeometry.depth > 0.002, '唇部失去了前后体积');
  assert(lipGeometry.standingWidthPixels > 3, '站立观看时唇线小于三个像素');
  await capture('player-seated', [0.45, 0.98, 1.15], [0, 0.42, 0.08], 1, 'stare');
  await page.evaluate(() => {
    const a = window.__kagari;
    a.camera.fov = 35;
    a.camera.updateProjectionMatrix();
  });
  await capture('face-smile', [0.3, 0.79, 0.75], [0, 0.59, 0.13], 1, 'smile');
  // 提高月光和纸面补光，检查角色材质在多灯叠加时仍能保留五官和发束。
  await page.evaluate(() => {
    const lights = window.__kagari.lights;
    lights.moonLight.intensity *= 2;
    lights.handLight.intensity *= 4;
    lights.paperLight.intensity *= 4;
  });
  await capture('face-bright-lights', [0.3, 0.79, 0.75], [0, 0.59, 0.13], 1, 'stare');
  assert.deepEqual(errors, [], '浏览器出现错误');
  const report = { details, coverage, shading, faceDetails, lipGeometry, mouthJoy, tracingDelta: tracingAfter - tracing, errors };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`截图：${pathToFileURL(output)}`);
} finally {
  await browser.close();
}
