/**
 * 原子化本地持久化。
 * 先写临时键并回读校验，成功后才替换主文档；任何一步失败都保留上一份完整数据。
 */
function validateValue<T>(value: unknown, validate: (data: unknown) => data is T): value is T {
  try {
    return validate(value)
  } catch {
    return false
  }
}

export function writeAtomic<T>(key: string, data: T): void {
  const payload = JSON.stringify({ payload: data })
  const tmpKey = `${key}.tmp`
  localStorage.setItem(tmpKey, payload)
  const readBack = localStorage.getItem(tmpKey)
  if (readBack !== payload) {
    // 临时文档都未完整落盘，主文档未动，调用方应保留内存状态并提示失败
    throw new Error('临时文档写入校验失败，已保留原有数据')
  }
  localStorage.setItem(key, payload)
  localStorage.removeItem(tmpKey)
}

export function readDoc<T>(key: string, validate: (data: unknown) => data is T): T | null {
  for (const candidate of [key, `${key}.tmp`]) {
    const raw = localStorage.getItem(candidate)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as { payload?: unknown }
      if (validateValue<T>(parsed?.payload, validate)) return parsed.payload
    } catch {
      // 损坏的文档落到下一个候选
    }
  }
  return null
}

export function removeDoc(key: string): void {
  localStorage.removeItem(key)
  localStorage.removeItem(`${key}.tmp`)
}
