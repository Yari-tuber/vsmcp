// 把 test/*.test.ts 用 esbuild 打成 out-test/*.test.cjs，再交给 node --test 跑。
// 被测模块都不依赖 vscode（vscode 标成 external，万一误用会在运行时报错）。
import esbuild from 'esbuild'
import { readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const root = path.dirname(new URL('../package.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const testDir = path.join(root, 'test')
const outDir = path.join(root, 'out-test')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const entries = readdirSync(testDir).filter((f) => f.endsWith('.test.ts'))
for (const file of entries) {
  await esbuild.build({
    entryPoints: [path.join(testDir, file)],
    bundle: true,
    outfile: path.join(outDir, file.replace(/\.ts$/, '.cjs')),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: 'inline',
    external: ['vscode'],
    define: { __EXT_VERSION__: JSON.stringify(version) },
    logLevel: 'warning',
  })
}
console.log(`已编译 ${entries.length} 个测试文件 → out-test/`)
