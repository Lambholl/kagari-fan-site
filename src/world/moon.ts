import * as THREE from 'three'
import { calculateEarthView } from './earth-view.ts'

/**
 * 加载本地地球贴图，创建银白色月轮并返回云层更新方法。
 *
 * @param radius - 球体半径（米）。
 * @param direction - 单位方向，坐标约定及有效范围同 `calculateEarthView`。
 */
export const createMoon = (radius: number, direction: THREE.Vector3) => {
  const group = new THREE.Group()
  group.name = 'moon'
  const loader = new THREE.TextureLoader()
  const surface = loader.load(`${import.meta.env.BASE_URL}textures/earth-surface.webp`)
  const clouds = loader.load(`${import.meta.env.BASE_URL}textures/earth-clouds.webp`)
  surface.colorSpace = THREE.SRGBColorSpace
  // 云图灰度表示覆盖率，使用默认的线性色彩空间。
  for (const texture of [surface, clouds]) {
    texture.wrapS = THREE.RepeatWrapping
    texture.anisotropy = 4
  }

  const sunDirection = direction
    .clone()
    .negate()
    .add(new THREE.Vector3(0.3, 1.1, 0))
    .normalize()
  const vertexShader = /* glsl */ `
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vPosition;
    void main() {
      vUv = uv;
      vNormal = normalize(mat3(modelMatrix) * normal);
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vPosition = worldPosition.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }
  `
  const uniforms = {
    uSurface: { value: surface },
    uClouds: { value: clouds },
    uSunDirection: { value: sunDirection },
    uCloudOffset: { value: 0 },
    // 贴图保留南纬 67.5°以北的范围，采样时恢复原球面的纬度坐标。
    uMapVMin: { value: 64 / 512 },
    uBrightness: { value: 1.12 },
  }
  const material = new THREE.ShaderMaterial({
    // 月面与星空、地平线云一起按 renderOrder 绘制，才能覆盖先画的天穹。
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms,
    vertexShader,
    fragmentShader: /* glsl */ `
      uniform sampler2D uSurface;
      uniform sampler2D uClouds;
      uniform vec3 uSunDirection;
      uniform float uCloudOffset;
      uniform float uMapVMin;
      uniform float uBrightness;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vPosition;
      void main() {
        vec3 n = normalize(vNormal);
        vec3 viewDir = normalize(cameraPosition - vPosition);
        float facing = max(dot(n, viewDir), 0.0);
        vec2 mapUv = vec2(vUv.x, (vUv.y - uMapVMin) / (1.0 - uMapVMin));
        vec3 land = texture2D(uSurface, mapUv).rgb;
        float luminance = dot(land, vec3(0.2126, 0.7152, 0.0722));
        // 用地球陆地亮度纹理调制银白色月面明暗，将色彩统一转为银灰阶。
        float terrain = smoothstep(0.025, 0.42, sqrt(luminance));
        float cloud = texture2D(uClouds, mapUv + vec2(uCloudOffset, 0.0)).r;
        cloud = smoothstep(0.12, 0.92, cloud);
        float value = mix(0.32, 0.82, terrain);
        value = mix(value, 0.90, cloud * 0.68);
        // 提亮月面上半部并保留下缘的灰蓝阴影，增强球体明暗立体感。
        float upper = smoothstep(-0.15, 0.8, n.y);
        value = mix(value, 0.92, upper * 0.62);
        vec3 silver = mix(vec3(0.46, 0.62, 0.73), vec3(0.82, 0.91, 0.97), value);
        float light = 0.42 + 0.58 * max(dot(n, uSunDirection), 0.0);
        float limb = mix(0.35, 1.0, pow(facing, 0.38));
        vec3 col = silver * value * light * limb * uBrightness;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
  const sphereGeometry = new THREE.SphereGeometry(radius, 96, 64)
  const globe = new THREE.Mesh(sphereGeometry, material)
  globe.name = 'moon-surface'
  globe.quaternion.copy(calculateEarthView(direction).quaternion)
  globe.renderOrder = -18
  globe.frustumCulled = false
  group.add(globe)

  return {
    group,
    /** 按经过的秒数和 0 到 1 的时间加速系数推进云层。 */
    update(dt: number, lapse: number) {
      // 平时基本静止；剧情时间加速时，云层稍稍移动。
      uniforms.uCloudOffset.value = (uniforms.uCloudOffset.value + dt * lapse * 0.008) % 1
    },
  }
}
