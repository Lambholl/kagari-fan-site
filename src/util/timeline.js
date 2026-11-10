// 由渲染循环驱动的小型时间轴：wait / tween 都返回 Promise，
// 这样剧情脚本可以写成一串 await，同时在标签页隐藏时自然暂停。

export function createTimeline() {
  const tasks = new Set();
  return {
    wait(seconds) {
      return new Promise((resolve) => {
        let t = 0;
        const task = (dt) => {
          t += dt;
          if (t >= seconds) {
            tasks.delete(task);
            resolve();
          }
        };
        tasks.add(task);
      });
    },
    /** fn(k) 以 0..1 的进度被逐帧调用 */
    tween(seconds, fn, ease = (k) => k * k * (3 - 2 * k)) {
      return new Promise((resolve) => {
        let t = 0;
        const task = (dt) => {
          t += dt;
          const k = Math.min(1, t / seconds);
          fn(ease(k), k);
          if (k >= 1) {
            tasks.delete(task);
            resolve();
          }
        };
        tasks.add(task);
      });
    },
    /** 等到条件成立 */
    until(pred) {
      return new Promise((resolve) => {
        const task = (dt) => {
          if (pred(dt)) {
            tasks.delete(task);
            resolve();
          }
        };
        tasks.add(task);
      });
    },
    update(dt) {
      for (const task of [...tasks]) task(dt);
    },
  };
}
