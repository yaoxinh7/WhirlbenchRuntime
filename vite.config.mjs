import { defineConfig } from 'vite'
import JavaScriptObfuscator from 'javascript-obfuscator'

function obfuscateUserChunk() {
  return {
    name: 'obfuscate-user-chunk',
    enforce: 'post',   // ← 保证在 terser 之后
    renderChunk(code, chunk) {
      if (chunk.name === 'index') {
        const result = JavaScriptObfuscator.obfuscate(code, {
          compact: true,
          target: 'browser',                 // 浏览器环境
          identifierNamesGenerator: 'hexadecimal',
          renameGlobals: false,
          renameProperties: false,           // 保持 false 避免破坏模块导出
          stringArray: true,
          stringArrayEncoding: ['base64'],   // 显式编码，效果更明显
          stringArrayThreshold: 1,
          stringArrayRotate: true,
          stringArrayShuffle: true,
          unicodeEscapeSequence: false,      // 与 base64 二选一即可
          numbersToExpressions: true,
          controlFlowFlattening: true,
          controlFlowFlatteningThreshold: 0.75,
          deadCodeInjection: false,
          debugProtection: false,            // 生产环境可开
          selfDefending: false,
          simplify: true,
          reservedNames: ['require', 'exports', 'module', '__filename', '__dirname', 'export'],
        })
        return { code: result.getObfuscatedCode() }
      }
      return null
    }
  }
}

export default defineConfig({
  plugins: [obfuscateUserChunk()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      external: ['fs', 'path'],
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('@babylonjs')) return 'babylon'
            return 'vendor'
          }
        }
      }
    },
    assetsInlineLimit: 10000000,
    sourcemap: false,
    emptyOutDir: true,
  }
})