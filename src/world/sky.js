import * as THREE from 'three';
import { makeNoise2D, fbm, mulberry32, smoothstep } from '../util/noise.js';

/**
 * 月亮所在方向。玩家从南面（+z）上山，月亮悬在丘顶背后偏东，
 * 于是走上山丘时，她正好坐在月轮下方。
 */
export const MOON_DIR = (() => {
  const az = THREE.MathUtils.degToRad(16); // 自正北(-z)向东(+x)偏转
  const el = THREE.MathUtils.degToRad(25);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
})();

const SKY_R = 1500;
const MOON_ANGULAR_RADIUS = THREE.MathUtils.degToRad(10.5);

function makeMoonTexture() {
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const n1 = makeNoise2D(301);
  const n2 = makeNoise2D(302);
  const n3 = makeNoise2D(303);
  const R = S / 2 - 6;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x - S / 2) / R;
      const dy = (y - S / 2) / R;
      const d = Math.hypot(dx, dy);
      const i = (y * S + x) * 4;
      if (d > 1.01) {
        img.data[i + 3] = 0;
        continue;
      }
      // 把圆盘当球面：让“海”的花纹在边缘被压扁，显得是个球
      const zz = Math.sqrt(Math.max(0, 1 - d * d));
      const sx = dx / (0.55 + 0.45 * zz);
      const sy = dy / (0.55 + 0.45 * zz);
      const big = fbm(n1, sx * 1.7 + 3.1, sy * 1.7 + 1.7, 5);
      const mid = fbm(n2, sx * 5 + 9, sy * 5 - 4, 4);
      const fine = fbm(n3, sx * 22, sy * 22, 3);
      // 月海：淡青白的月面上，晕开的蓝色斑块
      const mare = smoothstep(0.53, 0.66, big + (mid - 0.5) * 0.28);
      let r = 214 + fine * 30;
      let g = 238 + fine * 14;
      let b = 250;
      const mr = 70 + mid * 50;
      const mg = 130 + mid * 50;
      const mb = 205 + mid * 30;
      r = r + (mr - r) * mare * 0.86;
      g = g + (mg - g) * mare * 0.86;
      b = b + (mb - b) * mare * 0.7;
      // 细小的坑洼
      const crater = smoothstep(0.66, 0.7, mid) * (1 - mare) * 22;
      r -= crater;
      g -= crater * 0.7;
      const limb = 0.86 + 0.14 * zz;
      img.data[i] = r * limb;
      img.data[i + 1] = g * limb;
      img.data[i + 2] = b * (0.95 + 0.05 * zz);
      img.data[i + 3] = 255 * (1 - smoothstep(0.992, 1.006, d));
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeCloudTexture(seed) {
  const W = 512;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const n = makeNoise2D(seed);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      const f = fbm(n, u * 5, v * 3.2, 5);
      // 椭圆衰减，底边更厚实，顶边蓬松
      const ex = (u - 0.5) * 2;
      const ey = (v - 0.58) * 2.4;
      const fall = 1 - smoothstep(0.35, 1.0, Math.sqrt(ex * ex + ey * ey));
      const a = smoothstep(0.42, 0.75, f * 0.75 + fall * 0.5) * fall;
      const i = (y * W + x) * 4;
      const lum = 150 + f * 105;
      img.data[i] = lum;
      img.data[i + 1] = lum;
      img.data[i + 2] = lum;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createSky() {
  const group = new THREE.Group();
  group.name = 'sky';

  // —— 天穹 ——
  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uMoonDir: { value: MOON_DIR.clone() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uMoonDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 zen = vec3(0.006, 0.014, 0.055);
        vec3 mid = vec3(0.016, 0.05, 0.16);
        vec3 hor = vec3(0.045, 0.14, 0.30);
        vec3 col = mix(hor, mid, smoothstep(0.0, 0.28, h));
        col = mix(col, zen, smoothstep(0.2, 0.95, h));
        float md = max(dot(d, uMoonDir), 0.0);
        // 月晕：把夜冲淡成青色
        col += vec3(0.10, 0.30, 0.52) * pow(md, 5.0) * 0.55;
        col += vec3(0.30, 0.55, 0.80) * pow(md, 28.0) * 0.55;
        col += vec3(0.55, 0.80, 1.00) * pow(md, 160.0) * 0.6;
        // 地平线以下沉入黑暗
        col = mix(col, vec3(0.012, 0.03, 0.07), 1.0 - smoothstep(-0.12, 0.0, d.y));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 48, 24), domeMat);
  dome.renderOrder = -20;
  dome.frustumCulled = false;
  group.add(dome);

  // —— 星 ——
  const rand = mulberry32(909);
  const STAR_N = 2600;
  const sp = new Float32Array(STAR_N * 3);
  const ss = new Float32Array(STAR_N);
  const sc = new Float32Array(STAR_N * 3);
  for (let i = 0; i < STAR_N; i++) {
    // 整个球面均匀分布（延时摄影般旋转时，地平线下的星会升上来）
    const u = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const R = SKY_R * 0.96;
    sp[i * 3] = Math.cos(a) * s * R;
    sp[i * 3 + 1] = u * R;
    sp[i * 3 + 2] = Math.sin(a) * s * R;
    const mag = Math.pow(rand(), 5);
    ss[i] = 1.2 + mag * 3.4;
    const warm = rand();
    const br = 0.5 + rand() * 0.5 + mag * 0.6;
    sc[i * 3] = br * (0.8 + warm * 0.25);
    sc[i * 3 + 1] = br * (0.88 + warm * 0.1);
    sc[i * 3 + 2] = br * (1.05 - warm * 0.15);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(ss, 1));
  starGeo.setAttribute('color', new THREE.BufferAttribute(sc, 3));
  const starMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    vertexColors: true,
    uniforms: {
      uPixelRatio: { value: 1 },
      uMoonDir: { value: MOON_DIR.clone() },
      uGroupRot: { value: new THREE.Matrix3() },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      uniform float uPixelRatio;
      uniform vec3 uMoonDir;
      uniform mat3 uGroupRot;
      varying vec3 vColor;
      varying float vFade;
      void main() {
        vColor = color;
        vec3 wd = normalize(uGroupRot * position);
        // 靠近地平线与月亮的星被冲淡
        float md = max(dot(wd, uMoonDir), 0.0);
        vFade = smoothstep(-0.02, 0.22, wd.y) * (1.0 - smoothstep(0.80, 0.985, md));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPixelRatio;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vFade;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float a = 1.0 - smoothstep(0.05, 0.5, length(p));
        gl_FragColor = vec4(vColor * a * vFade, a * vFade);
      }
    `,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  stars.renderOrder = -19;
  // 让星空绕一根倾斜的天轴转动
  const starPivot = new THREE.Group();
  starPivot.rotation.set(THREE.MathUtils.degToRad(52), 0, THREE.MathUtils.degToRad(8));
  starPivot.add(stars);
  group.add(starPivot);

  // —— 月 ——
  const moonR = Math.tan(MOON_ANGULAR_RADIUS) * SKY_R * 0.9;
  const moon = new THREE.Mesh(
    new THREE.CircleGeometry(moonR, 96),
    new THREE.MeshBasicMaterial({
      map: makeMoonTexture(),
      transparent: true,
      depthWrite: false,
      fog: false,
      color: new THREE.Color(0.8, 0.8, 0.8),
    }),
  );
  moon.renderOrder = -18;
  moon.frustumCulled = false;
  group.add(moon);

  // —— 贴着地平线的云 ——
  const clouds = new THREE.Group();
  const cloudTex = [makeCloudTexture(51), makeCloudTexture(52), makeCloudTexture(53)];
  const CLOUD_N = 16;
  const cloudItems = [];
  for (let i = 0; i < CLOUD_N; i++) {
    const az = (i / CLOUD_N) * Math.PI * 2 + rand() * 0.3;
    const el = THREE.MathUtils.degToRad(1.5 + rand() * 7.5);
    const dist = SKY_R * 0.86;
    const w = 520 + rand() * 520;
    const hgt = w * (0.3 + rand() * 0.14);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    const md = Math.max(0, dir.dot(MOON_DIR));
    const lit = 0.16 + 0.75 * Math.pow(md, 3);
    const mat = new THREE.MeshBasicMaterial({
      map: cloudTex[i % 3],
      transparent: true,
      depthWrite: false,
      fog: false,
      opacity: 0.55 + rand() * 0.3,
      color: new THREE.Color(0.2 * lit + 0.02, 0.42 * lit + 0.035, 0.7 * lit + 0.07),
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, hgt), mat);
    mesh.position.copy(dir).multiplyScalar(dist);
    mesh.lookAt(0, 0, 0);
    mesh.renderOrder = -17;
    mesh.frustumCulled = false;
    clouds.add(mesh);
    cloudItems.push(mesh);
  }
  group.add(clouds);

  const tmpM4 = new THREE.Matrix4();
  const state = { lapse: 0, starAngle: 0, cloudAngle: 0 };

  return {
    group,
    moon,
    /** lapse: 0 = 静止的夜；1 = “不属于时间的时间”飞速流过 */
    setLapse(v) {
      state.lapse = v;
    },
    update(dt, camera, pixelRatio) {
      group.position.copy(camera.position);
      moon.position.copy(MOON_DIR).multiplyScalar(SKY_R * 0.9);
      moon.lookAt(camera.position);
      // 平时星空几乎不动——这里是从时间里脱落的夜
      state.starAngle += dt * (0.0012 + state.lapse * 0.9);
      state.cloudAngle += dt * (0.0006 + state.lapse * 0.35);
      stars.rotation.y = state.starAngle;
      clouds.rotation.y = state.cloudAngle;
      group.updateMatrixWorld(true);
      tmpM4.copy(stars.matrixWorld);
      starMat.uniforms.uGroupRot.value.setFromMatrix4(tmpM4);
      starMat.uniforms.uPixelRatio.value = pixelRatio;
    },
  };
}
