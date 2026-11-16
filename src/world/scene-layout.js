/** 场景旋转缩放、主树阻挡与各模式出生点配置（坐标单位为米，角度单位为弧度）。 */
export const SCENE_LAYOUT = {
  yaw: Math.PI / 2,
  scale: 6,
  offsetX: -6,
  offsetZ: 6.9,
  tree: { x: -5.15697162, z: -5.39702136, radius: 2 },
  spawn: { x: 0, z: 90, yaw: 0, pitch: 0.06 },
  respawn: { x: -1.3, z: 25, yaw: -0.07, pitch: 0.05 },
  freeSpawn: { x: -1.2, z: 7.5, yaw: -0.12, pitch: 0 },
};
