# 天体贴图

- `earth-surface.webp`：NASA Blue Marble，Land Surface, Ocean Color, and Sea Ice。原图 2048 × 1024，缩至 1024 × 512 后裁掉底部 64 行，网页使用 1024 × 448 WebP，质量 80。
  - 原图：https://assets.science.nasa.gov/content/dam/science/esd/eo/content-feature/bluemarble/images/land_ocean_ice_2048.jpg
- `earth-clouds.webp`：NASA Blue Marble，Clouds。原图 2048 × 1024，缩至 1024 × 512 后裁掉底部 64 行，网页使用 1024 × 448 WebP，质量 65。
  - 原图：https://assets.science.nasa.gov/content/dam/science/esd/eo/content-feature/bluemarble/images/cloud_combined_2048.jpg

来源说明：https://science.nasa.gov/earth/earth-observatory/the-blue-marble-true-color-global-imagery-at-1km-resolution/

Image credit: NASA Goddard Space Flight Center. Image by Reto Stöckli (land surface, shallow water, clouds); enhancements by Robert Simmon (ocean color, compositing, 3D globes, animation).

网页加载压缩后的 WebP，月轮着色器将它们处理成银白、灰蓝色。两张贴图保留南纬 67.5°到北极的范围，经度保持完整，供云层横向移动使用。

球面以东经 75°、北纬 20°为可见面中心。理想潮汐锁定模型根据天空方向计算地球北轴的倾斜，采用固定自转相位，忽略具体日期的天平动。运行 `node scripts/calculate-earth-view.js` 检查朝向和贴图覆盖范围；朝向或渲染角半径改变后，应重新检查裁剪和 `uMapVMin`。
