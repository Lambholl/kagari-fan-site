// 首屏加载进度：把资源下载、模型解析和场景准备合成一条进度。

const DOWNLOAD_SHARE = 0.72;
const PARSE_SHARE = 0.1;
const STEPS = {
  build: { label: '铺开场景', weight: 0.06 },
  compile: { label: '编译着色器', weight: 0.1 },
  frame: { label: '点亮第一帧', weight: 0.02 },
};
const STEP_NAMES = Object.keys(STEPS);

/**
 * 加载进度快照。
 * @typedef {object} LoadingState
 * @property {number} value - 总进度，取 0 至 1，只增不减。
 * @property {string} label - 当前阶段说明。
 * @property {boolean} isDone - 全部完成时为 true。
 */

const files = [];
const listeners = new Set();
let stepIndex = -1;
let isDone = false;
let shownValue = 0;

const toMegabytes = (bytes) => (bytes / 1048576).toFixed(1);

/** @returns {LoadingState} */
function snapshot() {
  if (isDone) return { value: 1, label: '准备就绪', isDone: true };
  if (stepIndex >= 0) {
    let value = DOWNLOAD_SHARE + PARSE_SHARE;
    for (let i = 0; i < stepIndex; i++) value += STEPS[STEP_NAMES[i]].weight;
    return { value, label: `${STEPS[STEP_NAMES[stepIndex]].label}…`, isDone: false };
  }
  let loaded = 0;
  let total = 0;
  let fractionSum = 0;
  let readyCount = 0;
  // 所有未完成的文件都拿到总大小后才按字节计算，否则小文件先下完会让进度先冲高再长时间停住。
  let hasAllSizes = files.length > 0;
  for (const file of files) {
    fractionSum += file.isReady ? 1 : file.total > 0 ? Math.min(1, file.loaded / file.total) : 0;
    if (file.isReady) readyCount++;
    if (file.total > 0) {
      loaded += Math.min(file.loaded, file.total);
      total += file.total;
    } else if (!file.isReady) {
      hasAllSizes = false;
    }
  }
  const count = Math.max(1, files.length);
  const isByteBased = hasAllSizes && total > 0;
  const download = isByteBased ? loaded / total : fractionSum / count;
  const value = DOWNLOAD_SHARE * download + PARSE_SHARE * (readyCount / count);
  let label;
  if (download < 1) label = isByteBased ? `下载资源 ${toMegabytes(loaded)} / ${toMegabytes(total)} MB` : '下载资源…';
  else label = `解析模型 ${readyCount} / ${files.length}`;
  return { value, label, isDone: false };
}

function notify() {
  const state = snapshot();
  shownValue = Math.max(shownValue, state.value);
  state.value = shownValue;
  for (const fn of listeners) fn(state);
}

/**
 * 订阅加载进度，订阅时立即以当前状态回调一次，之后每次进度变化都回调。
 * @param {(state: LoadingState) => void} fn
 * @returns {() => void} 取消订阅的函数。
 */
export function onLoadingProgress(fn) {
  listeners.add(fn);
  fn({ ...snapshot(), value: shownValue });
  return () => listeners.delete(fn);
}

/**
 * 登记一个首屏资源，并用 load 收到的进度回调统计它的下载字节。
 *
 * load 返回的 Promise 结束时（无论成功或失败）该资源计为就绪。
 * 进入 `loadingStep` 之后登记的资源不再计入进度。
 * @template T
 * @param {(onProgress: (event: {loaded: number, total: number}) => void) => Promise<T>} load - 加载函数，例如 `(onProgress) => loader.loadAsync(url, onProgress)`；`total` 为 0 表示大小未知。
 * @returns {Promise<T>} load 的结果，失败时以原错误 reject。
 */
export function trackLoad(load) {
  const file = { loaded: 0, total: 0, isReady: false };
  files.push(file);
  notify();
  const onProgress = (event) => {
    file.loaded = event.loaded;
    if (event.total > 0) file.total = event.total;
    notify();
  };
  return Promise.resolve()
    .then(() => load(onProgress))
    .finally(() => {
      file.isReady = true;
      notify();
    });
}

/**
 * 以流的方式下载文件，每收到一段数据就回调一次进度。
 * @param {string} url
 * @param {(event: {loaded: number, total: number}) => void} onProgress - `total` 取自 Content-Length，响应没有该头时为 0。
 * @returns {Promise<ArrayBuffer>} 完整的文件内容。
 * @throws {Error} 网络失败或 HTTP 状态不是 2xx 时 reject。
 */
export async function fetchWithProgress(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} 请求失败：HTTP ${response.status}`);
  // 服务器压缩传输时 Content-Length 是压缩后的大小，loaded 可能超过 total，trackLoad 会把比例截到 1。
  const total = Number(response.headers.get('Content-Length')) || 0;
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    onProgress({ loaded: buffer.byteLength, total: total || buffer.byteLength });
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({ loaded, total });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/**
 * 进入资源就绪后的准备步骤，进度跳到该步骤的起点；步骤只能前进，传入更早的步骤不生效。
 * @param {'build' | 'compile' | 'frame'} name
 * @returns {Promise<void>} 在下一帧绘制之后完成。
 */
export function loadingStep(name) {
  stepIndex = Math.max(stepIndex, STEP_NAMES.indexOf(name));
  notify();
  // 后续步骤会长时间占住主线程，先让出一帧把新的进度画到屏幕上。
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/** 把进度标记为全部完成。 */
export function finishLoading() {
  isDone = true;
  notify();
}
