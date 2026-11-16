import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/** 8 个零均值像素内亚像素抖动偏移（单位为像素），按像素中心对称分布。 */
export const TEMPORAL_SAMPLES = [
  [-7, 1], [3, -7], [7, 7], [-1, -3], [1, 5], [-5, -5], [5, -1], [-3, 3],
].map(([x, y]) => [x / 16, y / 16]);

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uColor, uDepth, uHistory;
  uniform vec2 uPixel, uClip;
  uniform vec3 uEye;
  uniform mat4 uInverseViewProjection, uPreviousViewProjection;
  uniform bool uHasHistory;

  vec3 current(vec2 uv) {
    vec3 c = texture2D(uColor, uv).rgb;
    return any(isnan(c)) || any(isinf(c)) ? vec3(0.0) : clamp(c, 0.0, 1000.0);
  }

  void main() {
    vec3 center = current(vUv);
    vec3 low = center, high = center, crossSum = vec3(0.0);
    for (int y = -1; y <= 1; ++y) {
      for (int x = -1; x <= 1; ++x) {
        if (x == 0 && y == 0) continue;
        vec3 c = current(vUv + vec2(float(x), float(y)) * uPixel);
        low = min(low, c);
        high = max(high, c);
        if (x == 0 || y == 0) crossSum += c;
      }
    }

    float depth = texture2D(uDepth, vUv).r;
    bool sky = depth >= 1.0;
    float eyeDepth = sky ? 0.0 : uClip.x * uClip.y / mix(uClip.y, uClip.x, depth);
    // 刚露出的边缘还没有历史，只轻轻混合四个相邻像素。
    vec3 result = mix(center, crossSum * 0.25, 0.18);
    if (uHasHistory) {
      vec4 world = uInverseViewProjection * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      // 天穹跟随相机平移，查找历史时只计算它的旋转。
      vec4 p = sky ? vec4(world.xyz - uEye * world.w, 0.0) : vec4(world.xyz / world.w, 1.0);
      vec4 oldClip = uPreviousViewProjection * p;
      if (oldClip.w > 0.0) {
        vec2 oldUv = oldClip.xy / oldClip.w * 0.5 + 0.5;
        if (all(greaterThanEqual(oldUv, uPixel * 0.5)) && all(lessThanEqual(oldUv, 1.0 - uPixel * 0.5))) {
          // 读取最近像素中心处的历史深度，避免双线性插值混合前景与背景深度。
          vec2 oldPixel = (floor(oldUv / uPixel) + 0.5) * uPixel;
          float oldDepth = texture2D(uHistory, oldPixel).a;
          bool matches = sky ? oldDepth == 0.0 :
            oldDepth > 0.0 && abs(oldDepth - oldClip.w) < 0.03 + oldClip.w * 0.035;
          float motion = length((oldUv - vUv) / uPixel);
          // 花茎和叶缘只占半个像素，采样点会在前景和背景间切换。
          // 慢移时允许少量邻域内的历史颜色，快速移过的遮挡仍按深度丢弃。
          float coverage = 0.45 * (1.0 - smoothstep(0.35, 1.75, motion));
          if (matches || coverage > 0.0) {
            vec3 history = clamp(texture2D(uHistory, oldUv).rgb, low, high);
            float weight = matches ? mix(0.88, 0.33, smoothstep(1.0, 16.0, motion)) : coverage;
            // 手里的杯子跟着镜头动，极近处不套用世界坐标推算出的历史。
            if (!sky) weight *= smoothstep(0.45, 1.25, eyeDepth);
            result = mix(center, history, weight);
          }
        }
      }
    }
    // HDR 颜色和线性深度放在同一份历史帧里。
    gl_FragColor = vec4(result, eyeDepth);
  }
`;

/** 时序抗锯齿通道：用亚像素抖动和深度重投影稳定细枝、花茎与纸边。 */
export class TemporalAAPass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera;
    this.frames = Array.from({ length: 2 }, () =>
      new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
    this.savedProjection = new THREE.Matrix4();
    this.viewProjection = new THREE.Matrix4();
    this.lastPosition = new THREE.Vector3();
    this.lastRotation = new THREE.Quaternion();
    this.uniforms = {
      uColor: { value: null }, uDepth: { value: null }, uHistory: { value: null },
      uPixel: { value: new THREE.Vector2(1, 1) }, uClip: { value: new THREE.Vector2(camera.near, camera.far) },
      uEye: { value: camera.position },
      uInverseViewProjection: { value: new THREE.Matrix4() },
      uPreviousViewProjection: { value: new THREE.Matrix4() },
      uHasHistory: { value: false },
    };
    this.resolve = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader, fragmentShader, depthTest: false, depthWrite: false,
    });
    this.copy = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: null } }, vertexShader,
      fragmentShader: `
        varying vec2 vUv;
        uniform sampler2D uColor;
        void main() { gl_FragColor = vec4(texture2D(uColor, vUv).rgb, 1.0); }
      `,
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.resolve);
    this.reset();
  }

  /** 清空历史帧积累并重置采样索引。 */
  reset() {
    this.uniforms.uHasHistory.value = false;
    this.sample = 0;
    this.latest = 0;
  }

  /** 调整双缓冲历史纹理尺寸并清空历史。 */
  setSize(width, height) {
    width = Math.floor(width);
    height = Math.floor(height);
    if (this.frames[0].width === width && this.frames[0].height === height) return;
    for (const target of this.frames) target.setSize(width, height);
    this.uniforms.uPixel.value.set(1 / width, 1 / height);
    this.reset();
  }

  /** 在场景渲染前应用当前帧的像素内偏移；镜头大幅跳变时自动清空历史。 */
  jitterCamera() {
    const { camera, uniforms } = this;
    if (this.lastPosition.distanceToSquared(camera.position) > 9 ||
        Math.abs(this.lastRotation.dot(camera.quaternion)) < 0.993) this.reset();
    this.lastPosition.copy(camera.position);
    this.lastRotation.copy(camera.quaternion);
    this.savedProjection.copy(camera.projectionMatrix);
    // 历史帧始终用未偏移的坐标对齐，采样点只影响这一帧的场景绘制。
    this.viewProjection.multiplyMatrices(this.savedProjection, camera.matrixWorldInverse);
    uniforms.uInverseViewProjection.value.copy(this.viewProjection).invert();
    const [x, y] = TEMPORAL_SAMPLES[this.sample];
    this.sample = (this.sample + 1) % TEMPORAL_SAMPLES.length;
    camera.projectionMatrix.elements[8] += 2 * x * uniforms.uPixel.value.x;
    camera.projectionMatrix.elements[9] += 2 * y * uniforms.uPixel.value.y;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  /** 在场景渲染后恢复未偏移的相机投影矩阵。 */
  restoreCamera() {
    this.camera.projectionMatrix.copy(this.savedProjection);
    this.camera.projectionMatrixInverse.copy(this.savedProjection).invert();
  }

  /** 执行历史帧重投影并写入输出缓冲。 */
  render(renderer, writeBuffer, readBuffer) {
    const history = this.frames[this.latest];
    const output = this.frames[1 - this.latest];
    this.uniforms.uColor.value = readBuffer.texture;
    this.uniforms.uDepth.value = readBuffer.depthTexture;
    this.uniforms.uHistory.value = history.texture;
    this.quad.material = this.resolve;
    renderer.setRenderTarget(output);
    this.quad.render(renderer);

    this.copy.uniforms.uColor.value = output.texture;
    this.quad.material = this.copy;
    renderer.setRenderTarget(writeBuffer);
    this.quad.render(renderer);
    this.latest = 1 - this.latest;
    this.uniforms.uPreviousViewProjection.value.copy(this.viewProjection);
    this.uniforms.uHasHistory.value = true;
  }

  /** 释放渲染目标、着色器材质与全屏四边形资源。 */
  dispose() {
    for (const target of this.frames) target.dispose();
    this.resolve.dispose();
    this.copy.dispose();
    this.quad.dispose();
  }
}
