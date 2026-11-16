import * as THREE from 'three';

/** 角色各部位的卡通着色预设，独立控制亮部与暗部颜色，避免多光源叠加过曝。 */
export const CHARACTER_PROFILES = {
  skin: { shade: 0xb4adb9, lit: 0xd6c8c0, shift: -0.25, softness: 0.42, textureGamma: 1, specular: 0, rim: 0 },
  detail: { shade: 0xd2d7e2, lit: 0xdde2ec, shift: -0.6, softness: 0.5, textureGamma: 1, specular: 0, rim: 0 },
  hair: { shade: 0x8598bb, lit: 0xc1d3e7, shift: -0.12, softness: 0.2, textureGamma: 1, specular: 0.065, rim: 0.035 },
  cloth: { shade: 0x7e8da9, lit: 0x9ab9dd, shift: -0.06, softness: 0.22, textureGamma: 0.82, specular: 0.012, rim: 0.015 },
  frill: { shade: 0xa0adc2, lit: 0xd7dfeb, shift: -0.1, softness: 0.28, textureGamma: 1, specular: 0.01, rim: 0 },
  ribbon: { shade: 0x9d9dc1, lit: 0xd8c5e2, shift: -0.1, softness: 0.26, textureGamma: 1, specular: 0.025, rim: 0.008 },
};

const characterLighting = /* glsl */ `
  uniform vec3 uToonShade;
  uniform vec3 uToonLit;
  uniform float uToonShift;
  uniform float uToonSoftness;
  uniform float uTextureGamma;
  uniform float uToonSpecular;
  uniform float uToonRim;

  float characterLightWeight = 0.0;
  float characterLitWeight = 0.0;
  float characterSpecularWeight = 0.0;
  vec3 characterLightTint = vec3(0.0);
  vec3 characterAmbient = vec3(0.0);

  void RE_CharacterDirect(const in IncidentLight light, const in vec3 position,
    const in vec3 normal, const in vec3 viewDir, const in vec3 clearcoatNormal,
    const in ToonMaterial material, inout ReflectedLight reflectedLight) {
    float energy = dot(light.color, vec3(0.2126, 0.7152, 0.0722));
    float ndl = dot(normal, light.direction);
    float width = max(uToonSoftness, fwidth(ndl) * 2.0);
    float band = smoothstep(uToonShift - width, uToonShift + width, ndl);
    // 在色阶内保留少量连续变化，发束和细褶不会变成整块纯色。
    band = mix(band, ndl * 0.5 + 0.5, 0.18);
    characterLightWeight += energy;
    characterLitWeight += band * energy;
    characterLightTint += light.color;
    vec3 halfDir = normalize(light.direction + viewDir);
    characterSpecularWeight += pow(saturate(dot(normal, halfDir)), 32.0) * energy;
  }

  void RE_CharacterIndirect(const in vec3 irradiance, const in vec3 position,
    const in vec3 normal, const in vec3 viewDir, const in vec3 clearcoatNormal,
    const in ToonMaterial material, inout ReflectedLight reflectedLight) {
    characterAmbient += irradiance;
  }

  #undef RE_Direct
  #undef RE_IndirectDiffuse
  #define RE_Direct RE_CharacterDirect
  #define RE_IndirectDiffuse RE_CharacterIndirect
`;

const characterOutput = /* glsl */ `
  float lightWeight = max(characterLightWeight, 0.0001);
  float litAmount = characterLitWeight / lightWeight;
  vec3 palette = mix(uToonShade, uToonLit, litAmount);
  // 环境色仅按 12% 权重轻微染色，防止蓝色纸面补光覆盖皮肤和眼睛的原本色调。
  vec3 illumination = characterLightTint + characterAmbient * 0.2;
  float illuminationLuma = max(dot(illumination, vec3(0.2126, 0.7152, 0.0722)), 0.0001);
  vec3 lightTint = clamp(illumination / illuminationLuma, vec3(0.6), vec3(1.4));
  palette *= mix(vec3(1.0), lightTint, 0.12);
  vec3 albedo = pow(max(diffuseColor.rgb, vec3(0.0)), vec3(uTextureGamma));
  float highlight = characterSpecularWeight / lightWeight * uToonSpecular;
  float edge = pow(1.0 - saturate(dot(normal, geometryViewDir)), 4.0) * uToonRim;
  vec3 outgoingLight = albedo * (palette + highlight + edge * vec3(0.5, 0.7, 1.0));
`;

/** 保留 Three.js 的蒙皮、表情、贴图与透明处理，创建可控亮暗部的角色卡通材质。 */
export function characterToon(color, profileName, opts = {}) {
  const profile = CHARACTER_PROFILES[profileName];
  const material = new THREE.MeshToonMaterial({ color, ...opts });
  material.userData.characterProfile = profileName;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uToonShade: { value: new THREE.Color(profile.shade) },
      uToonLit: { value: new THREE.Color(profile.lit) },
      uToonShift: { value: profile.shift },
      uToonSoftness: { value: profile.softness },
      uTextureGamma: { value: profile.textureGamma },
      uToonSpecular: { value: profile.specular },
      uToonRim: { value: profile.rim },
    });
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_toon_pars_fragment>', `#include <lights_toon_pars_fragment>\n${characterLighting}`)
      .replace('vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;', characterOutput);
  };
  material.customProgramCacheKey = () => `character-toon-v1-${profileName}`;
  return material;
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
  o.userData.outlineWidth = thickness;
  o.userData.outlineSource = mesh.name;
  o.raycast = () => {};
  mesh.add(o);
  return o;
}

/** 蒙皮网格的反向外壳描边：共用骨架，在蒙皮前沿法线撑大。 */
export function addSkinnedOutline(mesh, thickness = 0.0035, color = 0x06071a) {
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uThick = { value: thickness };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uThick;')
      .replace('#include <begin_vertex>', 'vec3 transformed = position + normalize(normal) * uThick;');
  };
  mat.customProgramCacheKey = () => `skinned-outline-${thickness}`;
  const o = new THREE.SkinnedMesh(mesh.geometry, mat);
  o.name = 'outline';
  o.userData.outlineWidth = thickness;
  o.userData.outlineSource = mesh.name;
  // 面部描边和原网格共用表情权重，眨眼与口型变化时轮廓一起变形。
  if (mesh.morphTargetInfluences) {
    o.morphTargetInfluences = mesh.morphTargetInfluences;
    o.morphTargetDictionary = mesh.morphTargetDictionary;
  }
  o.bind(mesh.skeleton, mesh.bindMatrix);
  o.position.copy(mesh.position);
  o.quaternion.copy(mesh.quaternion);
  o.scale.copy(mesh.scale);
  o.frustumCulled = false;
  o.raycast = () => {};
  mesh.parent.add(o);
  return o;
}

/** 角色及缎带使用的调色板常量。 */
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
