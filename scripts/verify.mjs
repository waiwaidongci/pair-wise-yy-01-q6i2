// 端到端逻辑验证入口：esbuild 打包 scripts/verify-logic.ts 后在 Node 运行
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const candidates = process.env.ESBUILD_PATH ? [process.env.ESBUILD_PATH] : []
candidates.push(resolve(root, 'node_modules/esbuild/bin/esbuild'))
const pnpmDir = resolve(root, 'node_modules/.pnpm')
if (existsSync(pnpmDir)) {
  for (const dir of readdirSync(pnpmDir).sort().reverse()) {
    if (dir.startsWith('esbuild@')) candidates.push(resolve(pnpmDir, dir, 'node_modules/esbuild/bin/esbuild'))
  }
}
const esbuild = candidates.find((path) => existsSync(path))
if (!esbuild) {
  console.error('未找到 esbuild，请先执行 pnpm install')
  process.exit(1)
}
const out = resolve(root, 'scripts/.verify.mjs')
execFileSync(esbuild, [
  resolve(root, 'scripts/verify-logic.ts'),
  '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`,
], { stdio: 'inherit', cwd: root })
try {
  execFileSync(process.execPath, [out], { stdio: 'inherit' })
} finally {
  rmSync(out, { force: true })
}
