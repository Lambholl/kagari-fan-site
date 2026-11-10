import * as THREE from 'three';

/** 赛璐珞风格的明暗阶梯。stops 是从暗到亮的亮度（0..255）。 */
export function makeGradientMap(stops) {
  const data = new Uint8Array(stops.length * 4);
  stops.forEach((v, i) => {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  });
  const tex = new THREE.DataTexture(data, stops.length, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export const GRAD_CLOTH = makeGradientMap([70, 150, 255]);
export const GRAD_SOFT = makeGradientMap([150, 205, 255]);
export const GRAD_SKIN = makeGradientMap([185, 228, 255]);

export function toon(color, opts = {}) {
  const { gradient = GRAD_CLOTH, emissive = 0x000000, emissiveIntensity = 1, ...rest } = opts;
  return new THREE.MeshToonMaterial({
    color,
    gradientMap: gradient,
    emissive,
    emissiveIntensity,
    ...rest,
  });
}

const outlineCache = new Map();
function outlineMaterial(thickness, color) {
  const key = `${thickness}:${color}`;
  if (!outlineCache.has(key)) {
    outlineCache.set(
      key,
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: {
          uThick: { value: thickness },
          uColor: { value: new THREE.Color(color) },
        },
        vertexShader: /* glsl */ `
          uniform float uThick;
          void main() {
            vec3 p = position + normalize(normal) * uThick;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          void main() { gl_FragColor = vec4(uColor, 1.0); }
        `,
      }),
    );
  }
  return outlineCache.get(key);
}

/** 反向外壳描边：把几何沿法线撑大一圈，只画背面。 */
export function addOutline(mesh, thickness = 0.0035, color = 0x06071a) {
  const o = new THREE.Mesh(mesh.geometry, outlineMaterial(thickness, color));
  o.name = 'outline';
  o.raycast = () => {};
  mesh.add(o);
  return o;
}

export const COLORS = {
  skin: 0xffe3d6,
  hair: 0xd8d5f4,
  dress: 0x1f2a38,
  dressDeep: 0x121522,
  frill: 0xe8eef8,
  tights: 0x16242e,
  black: 0x0b0b14,
  ribbonA: new THREE.Color(0.42, 0.2, 0.86), // 紫
  ribbonB: new THREE.Color(0.9, 0.22, 0.52), // 洋红
};
