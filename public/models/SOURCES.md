# 角色模型

`kagari-base.glb` 由 `.materials/characters/kagari/blender/v9-rigged.blend` 导出，包含上衣、背部装饰、VRM 式 `J_Bip_*` 骨架和表情形态键（`Fcl_*`）。

- 作者及来源：[qpyiu123 / Patchouli-model-warehouse](https://github.com/qpyiu123/Patchouli-model-warehouse)，`galgame/Rewrite/Kagari-v4-rigged.blend`。
- 模型许可：[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。来源仓库说明模型使用了 VRoid Studio 和 AIGC 素材。
- 网页适配：保留前臂贴身缠带并重命名材质供前端统一着为紫色，腕结和长短飘带由 `src/kagari/ribbons.js` 程序化生成；模型沿用骨骼驱动和表情形态键。
- 《Rewrite》及其角色的著作权归 ©VISUAL ARTS/Key 所有。

模型由 `src/kagari/` 驱动袖根修正、跪坐裙摆与表情。导出脚本在绑定姿势下仅保留面部表情及袖根修正形态键，并将基础贴图与透明度接入标准 PBR 输出供前端替换为卡通着色。

在项目根目录使用 Blender 4.5 重新导出 `public/models/kagari-base.glb`（仅写出目标 GLB，源 `.blend` 作为只读输入）：

```sh
blender -b --factory-startup .materials/characters/kagari/blender/v9-rigged.blend --python-exit-code 1 --python scripts/export-kagari.py
```

## 月夜场景

- `ground-desktop.glb`、`forest-desktop.glb`：从项目月夜花海场景源文件导出的主平台、外围地形与远景树林模型（电脑与移动端共用；移动优化档归档于 `.materials/moonlit-scene/archive/`）。岩壁使用 Rob Tuytel 的 [Aerial Rocks 02](https://polyhaven.com/a/aerial_rocks_02)（Poly Haven，CC0）。
- `tree-game-*.glb`：从同一场景源文件中的主树模型简化并导出（含 `desktop` 与 `mobile` 两档）；远处树林的面片由该主树渲染生成。

GLB 中的贴图均以 WebP 内嵌打包；法线、粗糙度与环境光遮蔽等数据贴图采用无损 WebP 编码。无极光夜空贴图位于 [public/textures/SOURCES.md](../textures/SOURCES.md)。

两档文件的规格、渲染管线及导出步骤见 [docs/scene-integration.md](../../docs/scene-integration.md)。
