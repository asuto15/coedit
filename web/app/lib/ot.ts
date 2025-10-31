export type Op =
  | { type: 'insert'; pos: number; text: string }
  | { type: 'delete'; pos: number; len: number }

export function applyOps(content: string, ops: Op[]): string {
  let s = content
  for (const op of ops) {
    if (op.type === 'insert') {
      const head = [...s].slice(0, op.pos).join('')
      const tail = [...s].slice(op.pos).join('')
      s = head + op.text + tail
    } else {
      const head = [...s].slice(0, op.pos).join('')
      const tail = [...s].slice(op.pos + op.len).join('')
      s = head + tail
    }
  }
  return s
}

export function diffToOps(before: string, after: string): Op[] {
  if (before === after) return []
  const a = [...before]
  const b = [...after]
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  let j = 0
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++
  const beforeMid = a.slice(i, a.length - j).join('')
  const afterMid = b.slice(i, b.length - j).join('')
  const ops: Op[] = []
  if (beforeMid.length > 0) ops.push({ type: 'delete', pos: i, len: beforeMid.length })
  if (afterMid.length > 0) ops.push({ type: 'insert', pos: i, text: afterMid })
  return ops
}

