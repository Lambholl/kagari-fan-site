import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

import { createTerrain, HILL_TOP, heightAt } from './world/terrain.js';
import { createSky, MOON_DIR } from './world/sky.js';
import { createPaper, isOnPaper } from './world/paper.js';
import { createDaisies } from './world/daisies.js';
import { createPresentation, scenePixelRatio } from './world/presentation.js';
import { TemporalAAPass } from './world/temporal-aa.js';
import { createKagari } from './kagari/kagari.js';
import { createRibbons } from './kagari/ribbons.js';
import { createPlayer } from './player.js';
import { createItems } from './items.js';
import { createUI } from './ui.js';
import { bindSelectSetting } from './settings.js';
import { createAudio } from './audio.js';
import { createStory } from './story.js';
import { createTimeline } from './util/timeline.js';
import { damp } from './util/noise.js';

/** 篝面朝西南：主角从南面上山时，正好看见她朝向自己左前方的侧脸 */
const KAGARI_YAW = THREE.MathUtils.degToRad(-40);

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uWarp: { value: 0 },
    uDesat: { value: 0 },
    uAberr: { value: 0 },
    uVignette: { value: 0.55 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uWarp, uDesat, uAberr, uVignette;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float r = length(c);
      // 眩晕：画面缓缓拧转、呼吸
      float ang = uWarp * 0.5 * sin(uTime * 2.1) * (1.0 - r);
      mat2 R = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
      vec2 uv = 0.5 + R * c * (1.0 + uWarp * 0.07 * sin(uTime * 3.3 + r * 9.0));
      float ab = uAberr * r * 0.014;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ab).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ab).b;
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(l) * vec3(1.0, 0.92, 0.96), uDesat);
      col *= 1.0 - uVignette * smoothstep(0.38, 1.0, r * 1.22);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/** 清理泛光前的 NaN 与 Infinity 像素，防止单个坏像素经模糊扩散成大片黑块。 */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      bool bad = any(isnan(c)) || any(isinf(c));
      gl_FragColor = bad ? vec4(0.0, 0.0, 0.0, 1.0) : min(c, vec4(1000.0));
    }
  `,
};

async function boot() {
  const app = document.getElementById('app');
  const params = new URLSearchParams(location.search);

  // ———————————————————— 渲染器 ————————————————————
  // Windows 默认把 WebGL 帧复制到不透明二维画布以避开图层黑块，开发模式加 ?present=webgl 可直接显示 WebGL。
  const directWebGL = import.meta.env.DEV && params.get('present') === 'webgl';
  const compat = !directWebGL && navigator.platform.startsWith('Win');
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  let pixelRatio = scenePixelRatio(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1, compat);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const presentation = createPresentation(renderer.domElement, compat);
  const display = presentation.canvas;
  app.appendChild(display);
  display.tabIndex = 0;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0b213b, 0.004);
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.08, 4000);
  scene.add(camera);

  // ———————————————————— 光 ————————————————————
  const hemi = new THREE.HemisphereLight(0x9db9ed, 0x243b4c, 1.65);
  scene.add(hemi);
  const moonLight = new THREE.DirectionalLight(0xbfd8ff, 3.0);
  moonLight.castShadow = true;
  moonLight.shadow.mapSize.set(2048, 2048);
  moonLight.shadow.camera.left = -14;
  moonLight.shadow.camera.right = 14;
  moonLight.shadow.camera.top = 14;
  moonLight.shadow.camera.bottom = -14;
  moonLight.shadow.camera.near = 1;
  moonLight.shadow.camera.far = 200;
  moonLight.shadow.bias = -0.0006;
  scene.add(moonLight, moonLight.target);
  const treeFill = new THREE.DirectionalLight(0x7a9ac9, 0.85);
  treeFill.position.set(-10, HILL_TOP + 12, 18);
  treeFill.target.position.set(-5, HILL_TOP + 9, -5);
  scene.add(treeFill, treeFill.target);
  // 纸面自己发出的光：一盏贴着她手边，一盏照亮整片纸周围
  const handLight = new THREE.PointLight(0x58b8ff, 0.6, 6, 1.2);
  handLight.position.set(-0.58, HILL_TOP + 0.16, 0.69);
  const paperLight = new THREE.PointLight(0x2f78ff, 1.6, 20, 1.4);
  paperLight.position.set(0.8, HILL_TOP + 1.1, -1.9);
  scene.add(handLight, paperLight);

  // ———————————————————— 世界 ————————————————————
  const mobile = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768;
  const [terrain, panorama] = await Promise.all([
    createTerrain({ mobile }),
    new THREE.TextureLoader().loadAsync(`${import.meta.env.BASE_URL}textures/sky-no-aurora-${mobile ? 'mobile' : 'desktop'}.webp`),
  ]);
  const sky = createSky(panorama);
  const paper = createPaper();
  const daisies = createDaisies();
  scene.add(terrain.group, sky.group, paper.group, daisies.group);

  const kagari = await createKagari();
  kagari.group.position.set(0, paper.surfaceY, 0);
  kagari.group.rotation.y = KAGARI_YAW;
  scene.add(kagari.group);
  const ribbons = createRibbons(kagari);

  // ———————————————————— 后期 ————————————————————
  // 半浮点离屏目标不开启多重采样，改由后处理阶段平滑边缘。
  const composer = new EffectComposer(renderer);
  for (const target of [composer.renderTarget1, composer.renderTarget2]) {
    target.depthTexture = new THREE.DepthTexture(target.width, target.height, THREE.UnsignedIntType);
  }
  const size = new THREE.Vector2();
  composer.addPass(new RenderPass(scene, camera));
  // 先合成相邻帧，再做泛光和剧情特效，避免把移动的屏幕效果存入历史。
  const taa = new TemporalAAPass(camera);
  composer.addPass(taa);
  composer.addPass(new ShaderPass(SanitizeShader));
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.5, 0.75, 0.86);
  composer.addPass(bloom);
  const finalPass = new ShaderPass(FinalShader);
  composer.addPass(finalPass);
  // 降低边缘检测阈值以捕捉暗夜场景中的细微轮廓。
  const smaa = new SMAAPass();
  smaa._materialEdges.defines.SMAA_THRESHOLD = '0.025';
  smaa.clear = true;
  const fxaa = new ShaderPass(FXAAShader);
  composer.addPass(smaa);
  composer.addPass(new OutputPass());
  composer.addPass(fxaa);
  const post = { warp: 0, desat: 0, aberr: 0 };

  // ———————————————————— 玩法 ————————————————————
  const tl = createTimeline();
  const ui = createUI(tl);
  bindSelectSetting(ui.el.antialias, 'kagari.antialias', (mode) => {
    taa.enabled = mode === 'taa';
    taa.reset();
    smaa.enabled = mode === 'smaa';
    fxaa.enabled = mode === 'fxaa';
  });
  const audio = createAudio();
  ui.setSound(audio.enabled);
  const items = createItems(camera, scene);
  let story = null;
  let hadLock = false;
  const player = createPlayer({
    camera,
    dom: display,
    hooks: {
      inputBlocked: (target) => ui.settingsOpen || target === ui.el.settings,
      onAction: () => {
        if (!ui.triggerPrompt()) ui.advance();
      },
      onAdvance: () => ui.advance(),
      onLockChange: (locked) => {
        if (locked) hadLock = true;
        ui.setPaused(!locked && hadLock && story?.state.mode === 'play');
      },
      onStep: (x, z, running) => audio.step(isOnPaper(x, z), running),
      onBoundary: () => story?.onBoundary(),
      onSit: (v) => ui.setSitLabel(v),
      onJoystick: (on, x, y, dx, dy) => ui.setJoystick(on, x, y, dx, dy),
    },
  });
  scene.add(player.body);
  story = createStory({ ui, tl, player, kagari, ribbons, paper, sky, items, audio, post, camera });

  ui.el.start.addEventListener('click', () => story.begin(false));
  ui.el.free.addEventListener('click', () => story.begin(true));
  ui.el.pause.addEventListener('click', () => player.requestLock());
  ui.el.sound.addEventListener('click', () => ui.setSound(audio.toggle()));
  ui.el.act.addEventListener('click', () => {
    if (!ui.triggerPrompt()) ui.advance();
  });
  ui.el.sit.addEventListener('click', () => {
    if (!player.state.moveLocked) player.setSitting(!player.state.sitting);
  });
  ui.el.sub.style.pointerEvents = 'auto';
  ui.el.sub.addEventListener('click', () => ui.advance());
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyM') ui.setSound(audio.toggle());
  });
  window.addEventListener('touchstart', () => ui.setTouchMode(), { passive: true, once: true });

  // ———————————————————— 尺寸 ————————————————————
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    // 竖屏时把视野放宽一些
    camera.fov = w < h ? 76 : 62;
    camera.updateProjectionMatrix();
    const nextRatio = scenePixelRatio(w, h, window.devicePixelRatio || 1, compat);
    if (nextRatio !== pixelRatio) {
      pixelRatio = nextRatio;
      renderer.setPixelRatio(pixelRatio);
      composer.setPixelRatio(pixelRatio);
    }
    renderer.setSize(w, h);
    composer.setSize(w, h);
    presentation.resize();
    renderer.getDrawingBufferSize(size);
    fxaa.uniforms.resolution.value.set(1 / size.x, 1 / size.y);
    const projectionPixels = size.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    paper.setProjection(projectionPixels);
    daisies.setProjection(projectionPixels);
  }
  window.addEventListener('resize', resize);
  resize();

  // ———————————————————— 循环 ————————————————————
  const debug = { cam: null };
  const tip = new THREE.Vector3();
  const titleLook = new THREE.Vector3();
  let last = performance.now();
  let time = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0.0001, (now - last) / 1000));
    last = now;
    time += dt;
    tl.update(dt);

    if (story.state.mode === 'title') {
      // 从南侧看向台顶，让花坡、主树与月轮保留参考图中的前后关系。
      const a = time * 0.06;
      const top = HILL_TOP;
      const wide = camera.aspect > 1.25;
      camera.position.set((wide ? -18 : -6) + Math.sin(a) * 0.25, top + 6 + Math.sin(a * 1.7) * 0.04, (wide ? 54 : 36) + Math.cos(a * 0.8) * 0.2);
      // 宽屏时把她和月亮让到画面右侧，给标题留出左半边
      titleLook.set(wide ? -13 : -3, top + (wide ? 14 : 13), -7);
      camera.lookAt(titleLook);
    } else {
      player.update(dt);
    }
    if (debug.cam) {
      camera.position.fromArray(debug.cam.pos);
      camera.lookAt(debug.cam.look[0], debug.cam.look[1], debug.cam.look[2]);
    }
    camera.updateMatrixWorld(true);

    kagari.update(dt, time, camera.position);
    story.update(dt, time);
    kagari.fingertipWorld(tip);
    paper.setHand(tip.x, tip.z, 0.35 + 0.65 * kagari.state.tracing);
    paper.update(dt, time);
    daisies.update(time);
    sky.update(dt, camera, pixelRatio);
    items.update(dt, time);
    audio.update();

    // 月光的阴影范围跟着主角走
    const px = story.state.mode === 'title' ? 0 : player.state.x;
    const pz = story.state.mode === 'title' ? 0 : player.state.z;
    moonLight.target.position.set(px, heightAt(px, pz), pz);
    moonLight.position.copy(moonLight.target.position).addScaledVector(MOON_DIR, 90);

    post.aberr = damp(post.aberr, 0, 1.6, dt);
    finalPass.uniforms.uTime.value = time;
    finalPass.uniforms.uWarp.value = post.warp;
    finalPass.uniforms.uDesat.value = post.desat;
    finalPass.uniforms.uAberr.value = post.aberr;
    if (taa.enabled) taa.jitterCamera();
    try {
      composer.render(dt);
    } finally {
      if (taa.enabled) taa.restoreCamera();
    }
    presentation.present();
  }

  // 首帧渲染完再揭开黑幕
  requestAnimationFrame((t) => {
    last = t;
    frame(t);
    requestAnimationFrame(() => {
      ui.setReady();
      ui.fade(0, 2.2);
      const auto = params.get('autostart');
      if (auto) story.begin(auto === 'free');
    });
  });

  // 调试入口（控制台用）
  window.__kagari = { THREE, scene, camera, renderer, display, terrain, daisies, player, story, kagari, ribbons, paper, sky, items, post, ui, debug, bloom, tl, lights: { hemi, moonLight, handLight, paperLight } };
}

// 让“正在铺开夜色…”先画出来，再开始生成场景
requestAnimationFrame(() => setTimeout(() => boot().catch((error) => {
  console.error('场景加载失败', error);
  document.getElementById('btn-start').textContent = '场景加载失败';
  document.querySelector('#title .desc').textContent = '请检查本地场景素材是否齐全，重启开发服务器后刷新页面。';
  document.getElementById('fade').style.opacity = '0';
}), 30));
