/** 将下拉框的选择应用到游戏，并在下次打开时恢复。 */
export function bindSelectSetting(select, key, apply) {
  try {
    const saved = localStorage.getItem(key);
    if (Array.from(select.options).some((option) => option.value === saved)) select.value = saved;
  } catch {
    // 浏览器不允许保存时，仍可在当前页面切换选项。
  }
  apply(select.value);
  select.addEventListener('change', () => {
    apply(select.value);
    try { localStorage.setItem(key, select.value); } catch { /* 只在本页生效 */ }
  });
}
