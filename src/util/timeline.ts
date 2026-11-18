// 由渲染循环驱动的小型时间轴：wait 和 tween 都返回 Promise，
// 这样剧情脚本可以写成一串 await，同时在标签页隐藏时自然暂停。

/** 创建由渲染循环推进的时间轴控制器。 */
export const createTimeline = () => {
  const tasks = new Set<(dt: number) => void>()
  return {
    /** 等待指定秒数的场景时间。 */
    wait(seconds: number) {
      return new Promise<void>((resolve) => {
        let t = 0
        const task = (dt: number) => {
          t += dt
          if (t >= seconds) {
            tasks.delete(task)
            resolve()
          }
        }
        tasks.add(task)
      })
    },
    /** fn(k, raw) 在指定秒数内按 0 到 1 的进度逐帧调用。 */
    tween(
      seconds: number,
      fn: (eased: number, raw: number) => void,
      ease = (k: number) => k * k * (3 - 2 * k),
    ) {
      return new Promise<void>((resolve) => {
        let t = 0
        const task = (dt: number) => {
          t += dt
          const k = Math.min(1, t / seconds)
          fn(ease(k), k)
          if (k >= 1) {
            tasks.delete(task)
            resolve()
          }
        }
        tasks.add(task)
      })
    },
    /** 等到条件成立。 */
    until(pred: (dt: number) => boolean) {
      return new Promise<void>((resolve) => {
        const task = (dt: number) => {
          if (pred(dt)) {
            tasks.delete(task)
            resolve()
          }
        }
        tasks.add(task)
      })
    },
    /** 按本帧经过的秒数推进时间轴。 */
    update(dt: number) {
      for (const task of [...tasks]) {
        task(dt)
      }
    },
  }
}
