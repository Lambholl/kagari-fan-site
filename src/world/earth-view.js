import * as THREE from 'three';

/**
 * 按理想潮汐锁定模型计算固定场景的地球朝向和观测角度。
 * 世界坐标以 +y 为天顶、-z 为月面真北，月球的地球直下点取经纬度 0°。
 * 球心正对东经 75°、北纬 20°，两颗天体的北轴夹角固定为 23.44°，忽略天平动。
 * @param {THREE.Vector3} direction 单位向量，y 分量须大于 0、小于 1。
 * @returns {{quaternion: THREE.Quaternion, longitudeDeg: number, latitudeDeg: number, rollDeg: number, lunarSiteLatitudeDeg: number, poleSeparationDeg: number}} 四元数将 SphereGeometry 的本地坐标转到世界坐标；角度字段均用度，rollDeg 从屏幕上方向右计量。
 */
export function calculateEarthView(direction) {
  const longitudeDeg = 75;
  const latitudeDeg = 20;
  const longitude = THREE.MathUtils.degToRad(longitudeDeg);
  const latitude = THREE.MathUtils.degToRad(latitudeDeg);
  const poleTilt = THREE.MathUtils.degToRad(23.44);
  const elevation = Math.asin(direction.y);
  const azimuth = Math.atan2(direction.x, -direction.z);
  const lunarSiteLatitude = Math.atan2(-Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation));
  const lunarNorth = new THREE.Vector3(0, Math.sin(lunarSiteLatitude), -Math.cos(lunarSiteLatitude));
  const forward = direction.clone().negate();
  const screenRight = new THREE.Vector3().crossVectors(THREE.Object3D.DEFAULT_UP, forward).normalize();
  const screenUp = new THREE.Vector3().crossVectors(forward, screenRight);

  // latitude 的绝对值须小于 poleTilt，才能满足选定的两轴夹角。
  // 夹角约束有两个镜像解，这里选择沿 tangent 正方向倾斜的北轴。
  const tangent = new THREE.Vector3().crossVectors(lunarNorth, forward).normalize();
  const earthNorth = lunarNorth.clone().multiplyScalar(Math.cos(poleTilt))
    .addScaledVector(forward, Math.sin(latitude))
    .addScaledVector(tangent, Math.sqrt(Math.sin(poleTilt) ** 2 - Math.sin(latitude) ** 2))
    .normalize();
  const worldUp = earthNorth.clone().addScaledVector(forward, -Math.sin(latitude)).normalize();
  const worldRight = new THREE.Vector3().crossVectors(worldUp, forward).normalize();
  const localForward = new THREE.Vector3(
    Math.cos(longitude) * Math.cos(latitude), Math.sin(latitude), -Math.sin(longitude) * Math.cos(latitude),
  );
  const localRight = new THREE.Vector3(-Math.sin(longitude), 0, -Math.cos(longitude));
  const localUp = new THREE.Vector3().crossVectors(localForward, localRight);
  const localBasis = new THREE.Matrix4().makeBasis(localRight, localUp, localForward);
  const worldBasis = new THREE.Matrix4().makeBasis(worldRight, worldUp, forward);

  return {
    quaternion: new THREE.Quaternion().setFromRotationMatrix(worldBasis.multiply(localBasis.invert())),
    longitudeDeg,
    latitudeDeg,
    rollDeg: THREE.MathUtils.radToDeg(Math.atan2(worldUp.dot(screenRight), worldUp.dot(screenUp))),
    lunarSiteLatitudeDeg: THREE.MathUtils.radToDeg(lunarSiteLatitude),
    poleSeparationDeg: THREE.MathUtils.radToDeg(earthNorth.angleTo(lunarNorth)),
  };
}
