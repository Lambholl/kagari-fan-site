import * as THREE from 'three'

/** 创建封闭球面天穹，将全景山峦贴图平滑过渡到天顶夜色，并绘制极光与月晕。 */
export const createSkyDome = (
  panorama: THREE.Texture,
  radius: number,
  moonDir: THREE.Vector3,
  moonRadius: number,
) => {
  panorama.colorSpace = THREE.SRGBColorSpace
  panorama.wrapS = THREE.RepeatWrapping
  const uniforms = {
    uPanorama: { value: panorama },
    uAuroraTime: { value: 0 },
    uMoonDir: { value: moonDir },
    uMoonRadius: { value: moonRadius },
  }
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      varying float vU;
      void main() {
        vDir = position;
        vU = uv.x;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uPanorama;
      uniform float uAuroraTime;
      uniform vec3 uMoonDir;
      uniform float uMoonRadius;
      varying vec3 vDir;
      varying float vU;

      float grain(float x) {
        float i = floor(x);
        float f = smoothstep(0.0, 1.0, fract(x));
        return mix(fract(sin(i * 17.13) * 15731.74), fract(sin((i + 1.0) * 17.13) * 15731.74), f);
      }

      vec3 curtain(vec3 d, vec2 direction, float phase) {
        float t = uAuroraTime;
        float forward = dot(d.xz, direction);
        float x = dot(d.xz, vec2(direction.y, -direction.x));
        float arc = 0.26 + 0.085 * sin(x * 5.0 + phase + t * 0.12)
                         + 0.041 * sin(x * 13.0 - t * 0.19 + phase);
        float h = d.y - arc;
        // 褶皱沿光幕缓缓移动，亮边之上拖出渐淡的青紫色光。
        float ray = grain(x * 76.0 + 2.1 * sin(h * 3.5 + x * 3.0) - t * 0.47 + phase);
        float fold = mix(0.28, 1.0, ray) * mix(0.40, 1.0, grain(x * 12.0 + t * 0.17 - phase));
        float band = smoothstep(-0.05, 0.015, h) * exp(-max(h, 0.0) * 8.0);
        band *= (1.0 - smoothstep(0.22, 0.44, h)) * smoothstep(0.26, 0.73, forward);
        vec3 blueGreen = vec3(0.014, 0.117, 0.138);
        vec3 violet = vec3(0.079, 0.027, 0.154);
        return mix(blueGreen, violet, smoothstep(0.01, 0.26, h)) * band * fold;
      }

      void main() {
        vec3 d = normalize(vDir);
        // 全景纹理按半径 200、高度 420 的圆柱投影制作，按俯仰角换算纹理 V 坐标并在高空淡出为夜空天顶色。
        float skyV = clamp((149.65 + 200.0 * d.y / max(length(d.xz), 0.2)) / 420.0, 0.0, 1.0);
        vec3 hills = texture2D(uPanorama, vec2(vU - 0.183, skyV)).rgb * 0.38;
        vec3 zenith = vec3(0.0028, 0.0085, 0.032);
        vec3 col = mix(hills, zenith, smoothstep(0.46, 0.77, d.y));
        col += curtain(d, vec2(-0.34, -0.9404), 0.8);
        col += curtain(d, vec2(0.57, -0.8216), 2.6) * 0.54;

        // 月晕从月轮边缘开始向外衰减：内圈较亮且收得快，外圈较暗且铺得更开。
        float outside = max(acos(clamp(dot(d, uMoonDir), -1.0, 1.0)) - uMoonRadius, 0.0);
        col += vec3(0.045, 0.085, 0.12) * exp(-outside / 0.009);
        col += vec3(0.001, 0.002, 0.004) * exp(-outside / 0.045);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
  const dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 32), material)
  dome.name = 'sky-dome'
  dome.renderOrder = -20
  dome.frustumCulled = false
  return { dome, uniforms }
}
