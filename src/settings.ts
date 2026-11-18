/**
 * 将滑条的值应用到游戏，并把值保存到 localStorage 以便下次打开时恢复。
 *
 * 绑定时先恢复已保存的值（超出滑条 min 至 max 的值会被忽略），立即调用一次 apply，之后每次拖动都调用。
 * @param input - `type="range"` 的滑条。
 * @param key - localStorage 键名。
 */
export const bindRangeSetting = (
  input: HTMLInputElement,
  key: string,
  apply: (value: number) => void,
): void => {
  try {
    const saved = Number(localStorage.getItem(key) ?? NaN)
    if (Number.isFinite(saved) && saved >= Number(input.min) && saved <= Number(input.max)) {
      input.value = String(saved)
    }
  } catch {
    // 浏览器禁止访问存储时，仍可在当前页面调节。
  }
  apply(input.valueAsNumber)
  input.addEventListener('input', () => {
    apply(input.valueAsNumber)
    try {
      localStorage.setItem(key, input.value)
    } catch {
      /* 禁止访问存储时仅在当前页生效 */
    }
  })
}

/** 将下拉框的选择应用到游戏，并把选项保存到 localStorage 以便下次打开时恢复。 */
export const bindSelectSetting = (
  select: HTMLSelectElement,
  key: string,
  apply: (value: string) => void,
): void => {
  try {
    const saved = localStorage.getItem(key)
    if (saved !== null && Array.from(select.options).some((option) => option.value === saved)) {
      select.value = saved
    }
  } catch {
    // 浏览器禁止访问存储时，仍可在当前页面切换选项。
  }
  apply(select.value)
  select.addEventListener('change', () => {
    apply(select.value)
    try {
      localStorage.setItem(key, select.value)
    } catch {
      /* 禁止访问存储时仅在当前页生效 */
    }
  })
}
