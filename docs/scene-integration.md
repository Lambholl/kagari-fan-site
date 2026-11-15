# 月夜场景接入

## 当前布局

- 使用缓坡版的主平台、外围地形、主树、森林面片和无极光远景，替换原来的程序化圆丘、针叶树和城市剪影。
- 游戏中整套场景统一放大到导出模型的 6 倍，绕 Y 轴旋转 90°，使缓坡朝向玩家的出发方向。Blender 源文件保持原样。
- 篝仍以世界原点为交互中心，地面高度为 14 米。纸张保留 7×6 米，完整放在椭圆台顶，主树位于左后方约 `(-5.16, -5.40)` 米处。
- 剧情出生点为 `(0, 90)`，死亡后回到 `(-1.3, 25)`，自由漫步从 `(-1.2, 7.5)` 开始。坐标和比例统一维护在 `src/world/scene-layout.js`。
- 地面继续使用原来的黑白雏菊网格、成片分布和摇摆效果，不加载 Blender 导出的花草模型。纸边留白、树根避让、悬崖和林地不种花。

## 地面与行走

`src/world/surface.js` 将显示地面的三角形按水平位置分格。行走、雏菊和纸张共同读取这份地面高度，纸张随台面轻微起伏。

每一步检查地面坡度与高度差，阻止跨过崖沿；遇到障碍时尝试沿边缘行走。主树树根另设圆形阻挡。

## 标题页和树旁黑块

黑块在 Windows 上的 Codex 内置浏览器、Firefox 和 Chrome 中都出现过，标题未进入游戏时也会闪。Windows 现在将绘制完成的 WebGL 帧复制到不透明的二维画布，页面只显示这张画布。标题和游戏共用这条路径。画布最多使用 1920×1080 对应的像素数，保留窗口的比例；超出时画质会略降。月光、阴影、泛光和剧情效果继续保留。

加载主树时会修复树皮的零长度切线，泛光前会去掉无效颜色值，避免把局部着色异常扩散成大黑块。用户已确认闪烁消失。

开发页可加 `present=webgl` 比较直接显示 WebGL 的路径。这个选项只用于排查，不进入正式构建。

## 天空与极光

旧远景来自开口圆筒，玩家抬头超过约 54° 就会看到圆筒上沿。现在由随相机移动的完整天穹绘制远景：地平线保留无极光贴图中的山峦，向上平滑过渡到天顶夜色。青紫极光朝北缓慢流动，形状和亮度由着色器计算，剧情加速时也会加快。星点、月轮和云仍单独绘制。

## 主树导出

缓坡版原树已有主干开口，以及与树身分离的两根粗枝。导出脚本在 Blender 中对齐比例、焊合树皮的重合点、接回两根粗枝并封上 15 处明显开口。只给新增面补纹理坐标；已有树皮保留原纹理坐标。两档均保留主干和近处分叉，只在外围合并近似共面的树皮三角形，并整片抽稀叶片。

| 档位 | 主树三角面 | 贴图大小 |
| --- | ---: | ---: |
| 电脑 | 87,973 | 1024×1024 |
| 手机 | 75,962 | 512×512 |

简化前主树为 111,683 个三角面。主树按设备选择档位，外围树林仍用原来的低面数面片。

重新导出（在项目目录运行）：

```powershell
& 'G:\blender4.5\blender.exe' --background --factory-startup --disable-autoexec --python-exit-code 1 --python scripts/export-scene-tree.py
```

该脚本只输出模型，不保存或覆盖源 Blender 文件。

## 本地素材与 Git

模型和贴图继续留在 Git 已忽略的 `.materials/`，本次不加入 Git 暂存区或提交。

- 原导出模型：`.materials/moonlit-scene/exports/moonlit-game-models/models/`
- 无极光贴图：`.materials/moonlit-scene/exports/moonlit-game-models/textures/{mobile,desktop}/sky-no-aurora.jpg`
- Blender 直出主树：`.materials/moonlit-scene/integration/source-tree/`
- 源场景：`.materials/moonlit-scene/blender/current/地形_月夜花海_缓坡版.blend`
- 原导出工作副本：`.materials/moonlit-scene/blender/export/game-export-grass-only-20261115.blend`

Vite 通过 `scripts/scene-assets.js` 只提供六个 GLB 和两张无极光贴图，不开放整个素材目录。运行构建时，将这些素材写入已忽略的 `dist/scene-assets/`。正式发布前再决定将模型加入仓库或单独分发。

新电脑需要先恢复上述本地素材目录。缺少素材时，开发服务器和构建命令会显示具体缺失路径。

## 运行与验收

```powershell
npm run dev
npm test
npm run build
```

自动测试覆盖坐标变换、重叠表面、台顶纸张范围、三处出生点、上坡路线、渲染像素预算及两档主树的网格连通性、材质与位置。

开发页面加 `?inspect=1` 会在浏览器控制台输出 `SCENE_QA`：检查全部雏菊的贴地误差、纸上花朵数量和上坡路线。加 `view=side`、`view=front`、`view=tree`、`view=crown` 或 `view=trunk` 可查看固定视角；这些入口不进入正式构建。

示例：`http://127.0.0.1:5173/?inspect=1&view=side&autostart=free`。

- 标题复测：打开 `/?inspect=1&view=title-check`，留在标题页采样 180 帧。
- 树旁复测：打开 `/?inspect=1&view=sweep&autostart=free`，在纸边、树根和坡道扫过树干与树冠，采样 144 帧。
- 两项结果都写入页面标题和控制台的 `SCENE_FRAMES`；在原来出现问题的窗口大小下同时观察画面。
- 天顶和极光：打开 `/?inspect=1&view=zenith&autostart=free` 朝正上方看，页面标题及 `SKY_QA` 会报告天顶黑色像素和极光变化像素数。用 `view=aurora` 查看地平线及动态光幕。
