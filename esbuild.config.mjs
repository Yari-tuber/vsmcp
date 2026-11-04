import esbuild from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'

const isWatch = process.argv.includes('--watch')
const isProd = process.argv.includes('--production')

// 版本号单一来源：从 package.json 读取，避免代码里硬编码造成版本漂移
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'], // Must be external - provided by VS Code runtime
  format: 'cjs',        // Must be cjs - VS Code extension host requires CommonJS
  platform: 'node',
  target: 'node20',
  sourcemap: !isProd,
  minify: isProd,
  define: {
    __EXT_VERSION__: JSON.stringify(version),
  },
}

if (isWatch) {
  const ctx = await esbuild.context(buildOptions)
  await ctx.watch()
  console.log('Watching for changes...')
} else {
  await esbuild.build(buildOptions)
  // 生产构建不带 sourcemap，顺手删掉开发构建留下的 .map，免得打进 vsix
  if (isProd) rmSync('out/extension.js.map', { force: true })
  console.log(`Build complete. (v${version})`)
}
