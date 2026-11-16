# 月夜场景说明

## 场景布局

- 地形与外围树林在游戏中整体放大 `6` 倍，绕 Y 轴旋转 `90°` 使缓坡朝向玩家出发的南侧，并对齐世界原点处的地面高度为 `14` 米。主树在导出阶段已按 `6` 倍比例缩放，加载时不再重复放大。
- 篝以世界原点为交互中心（纸面基准高度 `14.02` 米），面朝西南方向。巨大用纸尺寸为 `7 × 6` 米，完整落在椭圆台顶内，主树位于左后方约 `(-5.16, -5.40)` 米处。
- 剧情出生点为 `(0, 90)`，死亡后回到 `(-1.3, 25)`，自由漫步从 `(-1.2, 7.5)` 开始。坐标、旋转与比例统一维护在 `src/world/scene-layout.js`。
- 地面上的黑白雏菊按固定随机种子在客户端成片生成，避开纸面外扩 `0.25` 米范围及主树周围 `0.9` 米半径；悬崖与外围林地不种花。

## 地面与行走

- `src/world/surface.js` 提取地形中朝上的三角面并按 `4` 米水平方格索引；上下重叠处取最高的交点，供玩家行走、雏菊贴地和纸面起伏共用。
- 每一步检查地面坡度与高度差以阻挡陡崖，斜向遇阻时尝试沿单个坐标轴滑动；主树树根周围 `2` 米与篝的裙摆区域另设圆形阻挡。

## 画面呈现与抗锯齿

- **Windows 呈现与像素上限**：Windows 平台在每帧渲染完成后将 WebGL 帧复制到不透明的二维画布显示，避免浏览器直接合成实时 WebGL 图层出现黑块。二维画布模式渲染像素上限为 `1920 × 1080`，直接显示 WebGL 模式上限为 `2560 × 1440`，同时保持窗口宽高比。开发模式下加 `?present=webgl` 可直接看 WebGL 画布。
- **异常值清理**：加载主树时将零长度或非有限顶点切线修复为垂直于法线的单位向量；后处理泛光前清零 `NaN` 与无穷大像素并限制高光上限，防止局部着色异常经模糊扩散成黑块。
- **抗锯齿设置**：点击画面右上角齿轮可切换抗锯齿（鼠标锁定时先按 `Esc`），选择保存在本地存储中：
  - **快捷（FXAA）**（默认）：输出后做单帧快速边缘平滑。
  - **精细（SMAA）**：单帧边缘检测与混合。
  - **稳像（TAA）**：每帧做 8 点像素内采样偏移，按上一帧视角与线性深度重投影对齐。天空平移时仅按旋转对齐历史，近处随镜头移动的手持物按深度淡出历史权重；快速转头、缩改窗口或切镜头时清空历史。
  - **关闭**：关闭抗锯齿后处理。
- **远景花草与光点**：雏菊按花盘屏幕投影大小过渡：远景先绘制扩大后按原投影面积减淡的软边圆盘，近处再恢复立体花瓣并按宽度淡入细茎，斜看花盘时更晚切回立体花瓣，同时减小远景风摆幅度。纸上飘浮的细小光点同样限制最小像素尺寸并按面积比例减淡，避免亚像素闪烁。

## 天空与极光

- 封闭球面天穹随相机移动：地平线附近按圆柱投影映射无极光全景图，向上平滑过渡到天顶夜色。极光、星空、银白月轮与地平线云同步响应剧情中的时间加速。

## 模型导出与资源打包

原始 `.blend` 文件与导出中间文件存放在 Git 忽略的 `.materials/`，网页从 `public/models/` 和 `public/textures/` 加载（构建时复制到 `dist/models/` 和 `dist/textures/`）：

| 资产 | 电脑档 | 手机档 |
| --- | --- | --- |
| 地形 | `models/ground-desktop.glb` | `models/ground-desktop.glb` |
| 主树 | `models/tree-game-desktop.glb`（`87,973` 面，`1024×1024`） | `models/tree-game-mobile.glb`（`75,962` 面，`512×512`） |
| 远处树林 | `models/forest-desktop.glb` | `models/forest-desktop.glb` |
| 无极光夜空 | `textures/sky-no-aurora-desktop.webp` | `textures/sky-no-aurora-mobile.webp` |
| 角色 | `models/kagari-base.glb` | `models/kagari-base.glb` |

主树数据记录在 `.materials/moonlit-scene/integration/source-tree/game-triangles.json`（电脑档树皮 `71,663` 面 + 叶片 `16,310` 面；手机档树皮 `64,448` 面 + 叶片 `11,514` 面）。移动优化版地形与树林模型归档于 `.materials/moonlit-scene/archive/`。重新导出步骤（在项目根目录运行）：

1. 导出主树中间模型（焊合树皮重合点、接回 `2` 根断枝并封合 `15` 处地面以上开口，按档位抽稀叶片并简化外围树冠）：

   ```sh
   blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python scripts/export-scene-tree.py
   ```

2. 打包场景模型到 `public/models/` 与夜空贴图到 `public/textures/`（需要带 WebP 支持的 Pillow；颜色贴图使用质量 `90` 的有损 WebP，法线等数据贴图使用无损 WebP）：

   ```sh
   python scripts/pack-scene-webp.py
   ```

角色模型导出命令见 [public/models/SOURCES.md](../public/models/SOURCES.md)。

## 运行与调试

```sh
pnpm dev
pnpm build
```

开发模式下支持以下 URL 参数：

- `?autostart=story` 或 `?autostart=free`：跳过标题页直接进入剧情或自由漫步。
- `?present=webgl`：在 Windows 上直接使用 WebGL 画布显示。

示例：`http://127.0.0.1:5173/?autostart=free`。
