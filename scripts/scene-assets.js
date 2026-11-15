import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SCENE_FILES = [
  ...['mobile', 'desktop'].flatMap((quality) => [
    `ground-${quality}.glb`, `tree-game-${quality}.glb`,
    `forest-${quality}.glb`,
  ]),
];
export const SCENE_ASSET_DIR = fileURLToPath(new URL('../.materials/moonlit-scene/exports/moonlit-game-models/models/', import.meta.url));
export const SOURCE_TREE_DIR = fileURLToPath(new URL('../.materials/moonlit-scene/integration/source-tree/', import.meta.url));
const SKY_TEXTURE_DIR = fileURLToPath(new URL('../.materials/moonlit-scene/exports/moonlit-game-models/textures/', import.meta.url));
export const SKY_TEXTURES = new Map(['mobile', 'desktop'].map((quality) => [
  `sky-no-aurora-${quality}.jpg`, `${SKY_TEXTURE_DIR}${quality}/sky-no-aurora.jpg`,
]));

/** 只提供游戏用的模型和贴图，原始素材继续留在 Git 忽略目录。 */
export function sceneAssets() {
  const files = new Map(SCENE_FILES.map((name) => [name, `${name.startsWith('tree-') ? SOURCE_TREE_DIR : SCENE_ASSET_DIR}${name}`]));
  for (const [name, path] of SKY_TEXTURES) files.set(name, path);
  return {
    name: 'local-moonlit-scene',
    buildStart() {
      for (const [name, path] of files) {
        if (!existsSync(path)) this.error(`缺少本地场景素材：${path}。请恢复场景导出目录；主树模型由 scripts/export-scene-tree.py 生成。`);
      }
    },
    configureServer(server) {
      server.middlewares.use('/scene-assets', (req, res) => {
        const name = (req.url || '').split('?')[0].slice(1);
        const path = files.get(name);
        if (!path) { res.statusCode = 404; res.end('场景素材不存在'); return; }
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }
        res.setHeader('Content-Type', SKY_TEXTURES.has(name) ? 'image/jpeg' : 'model/gltf-binary');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'HEAD') { res.end(); return; }
        createReadStream(path).on('error', () => {
          res.statusCode = 404;
          res.end('场景素材不存在，请检查本地导出目录。');
        }).pipe(res);
      });
    },
    generateBundle() {
      for (const [name, path] of files) {
        this.emitFile({ type: 'asset', fileName: `scene-assets/${name}`, source: readFileSync(path) });
      }
    },
  };
}
