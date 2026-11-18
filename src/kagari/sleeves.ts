import * as THREE from 'three'
import { smoothstep } from '../util/noise.ts'

/** 创建单侧袖根同步函数：近肩少扭、向袖口逐渐跟上上臂转角，并在抬臂时顶开肩头内衬。 */
export const prepareSleeve = (
  side: 'L' | 'R',
  upper: THREE.Bone,
  bones: ReadonlyMap<string, THREE.Bone>,
  meshes: THREE.Mesh[],
) => {
  const bindInverse = upper.quaternion.clone().invert()
  const rolls = [1, 2, 3].map((n) => {
    const bone = bones.get(`Kagari_UpperArmRoll0${n}${side}`)
    if (!bone) {
      throw new Error(`角色缺少 ${side} 侧袖根辅助骨 ${n}`)
    }
    return { bone, bind: bone.quaternion.clone() }
  })
  const clearance = meshes.flatMap((mesh) => {
    const index = mesh.morphTargetDictionary?.[`Shoulder clearance • ${side}`]
    const weights = mesh.morphTargetInfluences
    return index === undefined || !weights ? [] : [{ weights, index }]
  })
  // Blender 骨骼的局部 Y 轴在 GLB 中对应 -Z。
  const axis = new THREE.Vector3(0, 0, -1)
  const delta = new THREE.Quaternion()
  const offset = new THREE.Quaternion()
  const blenderRotation = new THREE.Quaternion()
  const angles = new THREE.Euler(0, 0, 0, 'ZYX')
  return () => {
    delta.copy(bindInverse).multiply(upper.quaternion)
    // 四元数 q 和 -q 表示同一姿势，取较短的转角避免越过 180° 时跳变。
    const sign = delta.w < 0 ? -1 : 1
    const twist = 2 * Math.atan2(-delta.z * sign, delta.w * sign)
    rolls.forEach(({ bone, bind }, i) => {
      // 跪坐时双臂朝内压在身前，减小反扭量，让肩头内衬留在外层下面。
      offset.setFromAxisAngle(axis, -0.5 * (1 - i / 3) * twist)
      bone.quaternion.copy(bind).multiply(offset)
    })
    blenderRotation.set(delta.x, -delta.z, delta.y, delta.w)
    angles.setFromQuaternion(blenderRotation)
    const angle = Math.max(Math.abs(angles.x), Math.abs(angles.y), Math.abs(angles.z))
    // 仅在手臂大幅摆动时顶开袖根，内扭动作由辅助骨分担。
    const weight = smoothstep(0.11, 0.51, angle) * (1 - smoothstep(0.42, 1.02, Math.abs(twist)))
    for (const { weights, index } of clearance) {
      weights[index] = weight
    }
  }
}
