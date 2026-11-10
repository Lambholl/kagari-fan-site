import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { createTerrain, HILL_TOP } from './world/terrain.js';
import { createSky, MOON_DIR } from './world/sky.js';
import { createPaper, isOnPaper } from './world/paper.js';
import { createDaisies } from './world/daisies.js';
import { createKagari } from './kagari/kagari.js';
import { createRibbons } from './kagari/ribbons.js';
import { createPlayer } from './player.js';
import { createItems } from './items.js';
import { createUI } from './ui.js';
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

async function boot() {
  const app = document.getElementById('app');
  const params = new URLSearchParams(location.search);

  // ———————————————————— 渲染器 ————————————————————
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  app.appendChild(renderer.domElement);
  renderer.domElement.tabIndex = 0;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x06132a, 0.0052);
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.08, 4000);
  scene.add(camera);

  // ———————————————————— 光 ————————————————————
  const hemi = new THREE.HemisphereLight(0x7c9be6, 0x0b1830, 1.15);
  scene.add(hemi);
  const moonLight = new THREE.DirectionalLight(0xbfd8ff, 2.3);
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
  // 纸面自己发出的光：一盏贴着她手边，一盏照亮整片纸周围
  const handLight = new THREE.PointLight(0x58b8ff, 0.6, 6, 1.2);
  handLight.position.set(-0.58, HILL_TOP + 0.16, 0.69);
  const paperLight = new THREE.PointLight(0x2f78ff, 1.6, 20, 1.4);
  paperLight.position.set(0.8, HILL_TOP + 1.1, -1.9);
  scene.add(handLight, paperLight);

  // ———————————————————— 世界 ————————————————————
  const terrain = createTerrain();
  const sky = createSky();
  const paper = createPaper();
  const daisies = createDaisies();
  scene.add(terrain.group, sky.group, paper.group, daisies.group);

  const kagari = await createKagari();
  kagari.group.position.set(0, paper.surfaceY, 0);
  kagari.group.rotation.y = KAGARI_YAW;
  scene.add(kagari.group);
  const ribbons = createRibbons(kagari);

  // ———————————————————— 后期 ————————————————————
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.5, 0.75, 0.86);
  composer.addPass(bloom);
  const finalPass = new ShaderPass(FinalShader);
  composer.addPass(finalPass);
  composer.addPass(new OutputPass());
  const post = { warp: 0, desat: 0, aberr: 0 };

  // ———————————————————— 玩法 ————————————————————
  const tl = createTimeline();
  const ui = createUI(tl);
  const audio = createAudio();
  ui.setSound(audio.enabled);
  const items = createItems(camera, scene);
  let story = null;
  let hadLock = false;
  const player = createPlayer({
    camera,
    dom: renderer.domElement,
    hooks: {
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
    renderer.setSize(w, h);
    composer.setSize(w, h);
    paper.setProjection((h * pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)));
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
      // 标题画面：镜头在她斜前方缓缓漂移，月轮悬在身后
      // 相机在“月亮—她”这条线的延长线上：月轮正好悬在她身后
      const a = time * 0.06;
      const top = HILL_TOP;
      const wide = camera.aspect > 1.25;
      camera.position.set(-1.0 + Math.sin(a) * 0.25, top + 0.52 + Math.sin(a * 1.7) * 0.04, 3.3 + Math.cos(a * 0.8) * 0.2);
      // 宽屏时把她和月亮让到画面右侧，给标题留出左半边
      titleLook.set(wide ? -1.55 : -0.85, top + (wide ? 1.2 : 1.5), 0);
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
    moonLight.target.position.set(px, HILL_TOP * 0.5, pz);
    moonLight.position.copy(moonLight.target.position).addScaledVector(MOON_DIR, 90);

    post.aberr = damp(post.aberr, 0, 1.6, dt);
    finalPass.uniforms.uTime.value = time;
    finalPass.uniforms.uWarp.value = post.warp;
    finalPass.uniforms.uDesat.value = post.desat;
    finalPass.uniforms.uAberr.value = post.aberr;
    composer.render(dt);
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
  window.__kagari = { THREE, scene, camera, renderer, player, story, kagari, ribbons, paper, sky, items, post, ui, debug, bloom, tl, lights: { hemi, moonLight, handLight, paperLight } };
}

// 让“正在铺开夜色…”先画出来，再开始生成场景
requestAnimationFrame(() => setTimeout(boot, 30));
