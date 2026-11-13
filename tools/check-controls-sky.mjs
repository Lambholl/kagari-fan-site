// 先启动开发或预览服务器；浏览器和 Playwright 路径可用环境变量指定。
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.QA_URL || 'http://127.0.0.1:5173';
const origin = new URL(url).origin;
const output = resolve(process.env.QA_OUTPUT || '.materials/qa-controls-moon');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
const externalRequests = [];
const checks = [];

page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().startsWith('Failed to load resource:')) errors.push(m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`${r.status()} ${r.url()}`);
});
await page.route('**/*', (route) => {
  const requestUrl = new URL(route.request().url());
  if (/^https?:$/.test(requestUrl.protocol) && requestUrl.origin !== origin) {
    externalRequests.push(requestUrl.href);
    return route.abort();
  }
  return route.continue();
});

// 记录应用创建的音频上下文和第一个（总音量）增益节点，不改生产代码。
await page.addInitScript(() => {
  const NativeAudioContext = window.AudioContext;
  window.AudioContext = class extends NativeAudioContext {
    constructor(...args) {
      super(...args);
      window.__qaAudio = this;
    }
    createGain() {
      const gain = super.createGain();
      window.__qaMaster ??= gain;
      return gain;
    }
  };
});

async function waitReady() {
  await page.waitForFunction(() => window.__kagari, null, { timeout: 30000 });
}

async function startFree() {
  await page.locator('#btn-free').click();
  await page.waitForFunction(() => document.pointerLockElement);
  await page.waitForTimeout(1600);
}

async function releasePointer() {
  // 触发 Esc 释放鼠标时的实际 pointerlockchange；无头浏览器不处理硬件 Esc。
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => !document.pointerLockElement && !document.querySelector('#pause').hidden);
}

async function assertSound(on) {
  await page.waitForFunction((expected) => {
    const master = window.__qaMaster;
    return master && Math.abs(master.gain.value - (expected ? 0.9 : 0)) < 0.001;
  }, on);
  const state = await page.evaluate(() => {
    const sound = document.querySelector('#btn-sound');
    const rect = sound.getBoundingClientRect();
    return {
      hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.id,
      pressed: sound.getAttribute('aria-pressed'),
      off: sound.classList.contains('off'),
      stored: localStorage.getItem('kagari.sound'),
      locked: !!document.pointerLockElement,
      paused: !document.querySelector('#pause').hidden,
      context: window.__qaAudio.state,
      volume: window.__qaMaster.gain.value,
    };
  });
  assert.equal(state.hit, 'btn-sound');
  assert.equal(state.pressed, String(on));
  assert.equal(state.off, !on);
  assert.equal(state.stored, on ? 'on' : 'off');
  assert.equal(state.locked, false);
  assert.equal(state.paused, true);
  assert.equal(state.context, 'running');
  checks.push(state);
}

try {
  await page.goto(url);
  await waitReady();
  const moon = await page.evaluate(() => {
    const a = window.__kagari;
    const planet = a.sky.moon;
    const radius = planet.geometry.parameters.radius;
    const distance = planet.position.length();
    const direction = planet.position.clone().normalize();
    const orientation = planet.quaternion.clone();
    const cameraPosition = a.camera.position.clone();
    const moved = cameraPosition.clone().add(new a.THREE.Vector3(20, 3, -15));
    a.sky.update(0, { position: moved }, 1);
    const relative = planet.getWorldPosition(new a.THREE.Vector3()).sub(moved);
    const drift = relative.clone().normalize().distanceTo(direction);
    const rotationDrift = orientation.angleTo(planet.quaternion);
    a.sky.update(0, { position: cameraPosition }, 1);
    return {
      name: planet.name,
      geometry: planet.geometry.type,
      texture: planet.material.emissiveMap.image.currentSrc,
      size: [planet.material.emissiveMap.image.naturalWidth, planet.material.emissiveMap.image.naturalHeight],
      colorSpace: planet.material.emissiveMap.colorSpace,
      angularRadius: a.THREE.MathUtils.radToDeg(Math.asin(radius / distance)),
      drift,
      rotationDrift,
      nearsideU: new a.THREE.Raycaster(cameraPosition, direction).intersectObject(planet)[0].uv.x,
      emissiveIntensity: planet.material.emissiveIntensity,
      glow: {
        name: a.sky.moonGlow.name,
        intensity: a.sky.moonGlow.material.uniforms.uIntensity.value,
        additive: a.sky.moonGlow.material.blending === a.THREE.AdditiveBlending,
        depthTest: a.sky.moonGlow.material.depthTest,
        depthWrite: a.sky.moonGlow.material.depthWrite,
        beforeSurface: a.sky.moonGlow.renderOrder < planet.renderOrder,
      },
    };
  });
  assert.equal(moon.name, 'moon');
  assert.equal(moon.geometry, 'SphereGeometry');
  assert.equal(new URL(moon.texture).origin, origin);
  assert.match(moon.texture, /\/textures\/moon-lroc-2048\.jpg$/);
  assert.deepEqual(moon.size, [2048, 1024]);
  assert.equal(moon.colorSpace, 'srgb');
  assert.ok(Math.abs(moon.angularRadius - 10.5) < 0.001);
  assert.ok(moon.drift < 1e-6 && moon.rotationDrift < 1e-6);
  assert.ok(Math.abs(moon.nearsideU - 0.5) < 0.001);
  assert.equal(moon.emissiveIntensity, 1.35);
  assert.equal(moon.glow.name, 'moon-glow');
  assert.ok(moon.glow.intensity > 0 && moon.glow.additive && moon.glow.beforeSurface);
  assert.ok(moon.glow.depthTest && !moon.glow.depthWrite);

  await page.waitForTimeout(3500);
  await page.evaluate(() => {
    const a = window.__kagari;
    a.debug.cam = {
      pos: a.camera.position.toArray(),
      look: a.camera.position.clone().add(a.camera.getWorldDirection(new a.THREE.Vector3())).toArray(),
    };
    document.querySelector('#title').hidden = true;
  });
  await page.waitForTimeout(150);
  const bloom = await page.evaluate(() => {
    const a = window.__kagari;
    const target = a.bloom.renderTargetBright;
    const pixels = new Uint16Array(target.width * target.height * 4);
    a.renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels);
    const center = a.sky.moon.getWorldPosition(new a.THREE.Vector3()).project(a.camera);
    const cx = (center.x * 0.5 + 0.5) * target.width;
    const cy = (center.y * 0.5 + 0.5) * target.height;
    let peak = 0;
    let litPixels = 0;
    for (let y = Math.max(0, Math.floor(cy - 70)); y < Math.min(target.height, cy + 70); y++) {
      for (let x = Math.max(0, Math.floor(cx - 70)); x < Math.min(target.width, cx + 70); x++) {
        const v = a.THREE.DataUtils.fromHalfFloat(pixels[(y * target.width + x) * 4]);
        peak = Math.max(peak, v);
        if (v > 0.01) litPixels++;
      }
    }
    return { peak, litPixels, strength: a.bloom.strength, threshold: a.bloom.threshold };
  });
  assert.ok(bloom.peak > 1 && bloom.litPixels > 100, '月面亮部应进入 HDR 辉光缓冲');
  assert.equal(bloom.strength, 0.5);
  assert.equal(bloom.threshold, 0.86);
  await page.screenshot({ path: resolve(output, 'moon-scene.png') });
  await page.evaluate(() => {
    window.__kagari.sky.moonGlow.visible = false;
    window.__kagari.bloom.enabled = false;
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(output, 'moon-without-glow.png') });
  await page.evaluate(() => {
    window.__kagari.sky.moonGlow.visible = true;
    window.__kagari.bloom.enabled = true;
  });
  await page.evaluate(() => {
    window.__kagari.debug.cam = null;
    document.querySelector('#title').hidden = false;
  });

  await startFree();
  await releasePointer();
  await page.locator('#btn-sound').click();
  await assertSound(false);
  await page.locator('#btn-sound').click();
  await assertSound(true);

  await page.locator('#btn-help').click();
  assert.equal(await page.locator('#help').isVisible(), true);
  await page.locator('#btn-help').click();
  assert.equal(await page.locator('#help').isVisible(), false);

  await page.locator('#btn-sound').click();
  await assertSound(false);
  await page.evaluate(() => window.__qaAudio.suspend());
  await page.locator('#btn-sound').click();
  await assertSound(true);

  for (let i = 0; i < 3; i++) {
    await page.locator('#pause span').click();
    await page.waitForFunction(() => document.pointerLockElement && document.querySelector('#pause').hidden);
    await releasePointer();
    await page.locator('#btn-sound').click();
    await assertSound(false);
    await page.locator('#btn-sound').click();
    await assertSound(true);
  }

  await page.keyboard.press('m');
  await assertSound(false);
  await page.reload();
  await waitReady();
  assert.equal(await page.locator('#btn-sound').getAttribute('aria-pressed'), 'false');
  await startFree();
  await releasePointer();
  await assertSound(false);
  await page.locator('#btn-sound').click();
  await assertSound(true);
  await page.screenshot({ path: resolve(output, 'released-pointer-sound-on.png') });

  assert.deepEqual(externalRequests, [], '场景资源应从本地站点加载');
  assert.deepEqual(errors, [], '浏览器错误');
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ moon, bloom, checks, externalRequests, errors }, null, 2));
  console.log(JSON.stringify({ moon, bloom, soundChecks: checks.length, externalRequests, errors }, null, 2));
} finally {
  await browser.close();
}
