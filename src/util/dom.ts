type GetElement = {
  (id: string): HTMLElement
  <T extends HTMLElement>(id: string, elementType: abstract new () => T): T
}

/** 按 ID 获取页面声明的 HTML 元素，找不到或类型不符时抛出错误。 */
export const getElement = ((
  id: string,
  elementType: abstract new () => HTMLElement = HTMLElement,
) => {
  const element = document.getElementById(id)
  if (!(element instanceof elementType)) {
    throw new Error(`页面元素 #${id} 缺失或类型不符`)
  }
  return element
}) as GetElement

/** 查找容器内必需的 HTML 元素，找不到时抛出错误。 */
export const getChild = (root: HTMLElement, selector: string): HTMLElement => {
  const child = root.querySelector(selector)
  if (!(child instanceof HTMLElement)) {
    throw new Error(`页面元素 ${selector} 缺失或类型不符`)
  }
  return child
}

/** 获取用于绘制纹理或呈现画面的二维上下文，创建失败时抛出错误。 */
export const getContext2D = (
  canvas: HTMLCanvasElement,
  options?: CanvasRenderingContext2DSettings,
): CanvasRenderingContext2D => {
  const context = canvas.getContext('2d', options)
  if (!context) {
    throw new Error('无法创建二维画布上下文')
  }
  return context
}
