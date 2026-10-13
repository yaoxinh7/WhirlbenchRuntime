import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import nativePlugin from 'rollup-plugin-natives';
import copy from 'rollup-plugin-copy';

const _platforms = [
    'win32_x64',
    'win32-x64'
];

const _targets = [];
for (const platform of _platforms) {
    _targets.push(
        {
            src: `node_modules/**/*${platform}*.node`,
            dest: 'dist_b/',
        },
        {
            src: `node_modules/**/*${platform}*/**/*.node`,
            dest: 'dist_b/',
        },
    )
}


export default {
    input: './src/main.js',
    output: {
        file: './dist_b/server.cjs',
        format: 'cjs',
        inlineDynamicImports: true,
        //sourcemap: true,
    },
    plugins: [
        resolve({ preferBuiltins: true }),
        commonjs({
            ignoreDynamicRequires: true

        }),
        terser({
            compress: {
                drop_console: false,
                drop_debugger: true,
            },
            format: {
                comments: false,
            },
        }),
        copy({
            targets: [
                ..._targets,
                { src: 'node_modules/**/*.wasm', dest: 'dist_b', flatten: false }
            ]
        }),
    ],
};