import createModule from "./wasm-zstd.js";

let modulePromise;
let moduleInstance;

function toUint8Array(value) {
    if (value instanceof Uint8Array) {
        return value;
    }
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new TypeError("Expected a Uint8Array, ArrayBuffer, or ArrayBuffer view");
}

function resolveWasmUrl(wasmUrl) {
    const resolved = String(wasmUrl);
    if (typeof globalThis !== "undefined" && "location" in globalThis && globalThis.location?.href) {
        try {
            return new URL(resolved, globalThis.location.href).href;
        } catch {
            return resolved;
        }
    }
    return resolved;
}

function normalizeInitOptions(options = {}) {
    const moduleOptions = { ...options.module };

    if (options.wasmBinary != undefined) {
        moduleOptions.wasmBinary = toUint8Array(options.wasmBinary);
        moduleOptions.locateFile ??= (path) => path;
    } else if (options.wasmUrl != undefined) {
        const wasmUrl = resolveWasmUrl(options.wasmUrl);
        moduleOptions.locateFile = (path, prefix) =>
            path.endsWith(".wasm") ? wasmUrl : `${prefix}${path}`;
    } else if (options.locateFile != undefined) {
        moduleOptions.locateFile = options.locateFile;
    } else {
        throw new Error(
            "@ioai/wasm-zstd: init() requires wasmUrl or wasmBinary. " +
            'In Vite: import wasmUrl from "@ioai/wasm-zstd/wasm-zstd.wasm?url"; await init({ wasmUrl });',
        );
    }

    return moduleOptions;
}

export async function init(options = {}) {
    if (moduleInstance != undefined) {
        return;
    }

    const moduleOptions = normalizeInitOptions(options);

    modulePromise ??= createModule(moduleOptions).then((mod) => {
        moduleInstance = mod;
    });
    await modulePromise;
}

function getModule() {
    if (moduleInstance == undefined) {
        throw new Error("wasm-zstd has not been initialized. Call and await init() before using it.");
    }
    return moduleInstance;
}

export function compressBound(srcSize) {
    return getModule()._compressBound(srcSize);
}

export function compress(src, compressionLevel = 3) {
    const module = getModule();
    const input = toUint8Array(src);
    const srcSize = input.byteLength;
    const destSize = compressBound(srcSize);

    const srcPointer = module._malloc(srcSize);
    const destPointer = module._malloc(destSize);

    try {
        new Uint8Array(module.HEAPU8.buffer, srcPointer, srcSize).set(input);
        const resultSize = module._compress(destPointer, destSize, srcPointer, srcSize, compressionLevel);
        if (resultSize === -1) {
            throw new Error("zstd compression failed");
        }
        return module.HEAPU8.slice(destPointer, destPointer + resultSize);
    } finally {
        module._free(srcPointer);
        module._free(destPointer);
    }
}

export function decompress(src, destSize) {
    const module = getModule();
    const input = toUint8Array(src);
    const outputSize = Number(destSize);
    if (!Number.isFinite(outputSize) || outputSize < 0) {
        throw new RangeError("Expected destSize to be a non-negative finite number");
    }

    const srcPointer = module._malloc(input.byteLength);
    const destPointer = module._malloc(outputSize);

    try {
        new Uint8Array(module.HEAPU8.buffer, srcPointer, input.byteLength).set(input);
        const resultSize = module._decompress(destPointer, outputSize, srcPointer, input.byteLength);
        if (resultSize === -1) {
            throw new Error("zstd decompression failed");
        }
        return module.HEAPU8.slice(destPointer, destPointer + resultSize);
    } finally {
        module._free(srcPointer);
        module._free(destPointer);
    }
}

/**
 * 将源数据压缩后直接写入目标缓冲区的指定偏移位置（高效版）。
 * 
 * 该函数信任用户提供的目标缓冲区有足够空间容纳压缩后的数据，
 * 不会进行额外的大小检查（若担心溢出，可自行调用 compressBound 预判）。
 * 压缩失败或目标空间不足（未检查）时返回 0，否则返回实际写入字节数。
 * 
 * @param {ArrayBuffer|TypedArray} buffer - 待压缩的源数据（Uint8Array、ArrayBuffer 或任意 TypedArray）。
 * @param {ArrayBuffer|TypedArray} target - 用于接收压缩结果的目标缓冲区（ArrayBuffer 或 TypedArray）。
 * @param {number} offset - 写入目标缓冲区的起始偏移量（字节），必须为非负整数。
 * @param {number} [compressionLevel=3] - 压缩级别，范围通常为 1~22，默认 3。
 * @returns {number} 实际写入的字节数；若压缩失败（如数据损坏、参数无效）则返回 0。
 * 
 * @example
 * const src = new Uint8Array([1,2,3,4]);
 * const out = new Uint8Array(1024);
 * const written = compressInto(src, out, 0, 5);
 * console.log(`压缩后大小: ${written}`);
 */
export function compressInto(buffer, target, offset, compressionLevel = 3) {
  const module = getModule();
  const input = toUint8Array(buffer);
  const targetView = toUint8Array(target);

  const srcSize = input.byteLength;
  const maxDestSize = module._compressBound(srcSize);

  // 容量不足时直接返回 0（用户信任时此检查可移除，但保留不损失性能）
  if (offset + maxDestSize > targetView.length) {
    return 0;
  }

  const srcPtr = module._malloc(srcSize);
  const destPtr = module._malloc(maxDestSize);

  try {
    new Uint8Array(module.HEAPU8.buffer, srcPtr, srcSize).set(input);
    const resultSize = module._compress(destPtr, maxDestSize, srcPtr, srcSize, compressionLevel);
    if (resultSize === -1) {
      return 0;
    }
    targetView.set(module.HEAPU8.subarray(destPtr, destPtr + resultSize), offset);
    return resultSize;
  } finally {
    module._free(srcPtr);
    module._free(destPtr);
  }
}

/**
 * 将压缩数据解压后直接写入目标缓冲区的指定偏移位置（高效版）。
 * 
 * 该函数会检查目标缓冲区是否有足够空间容纳解压后的数据（由 size 参数指定），
 * 若空间不足则直接返回 0，避免写入越界。解压成功后返回实际写入的字节数（通常等于 size）。
 * 
 * @param {ArrayBuffer|TypedArray} buffer - 待解压的压缩数据（Uint8Array、ArrayBuffer 或任意 TypedArray）。
 * @param {ArrayBuffer|TypedArray} target - 用于接收解压结果的目标缓冲区（ArrayBuffer 或 TypedArray）。
 * @param {number} offset - 写入目标缓冲区的起始偏移量（字节），必须为非负整数。
 * @param {number} size - 解压后预期的大小（字节数），必须提前知道（通常来自原始数据长度或元数据）。
 * @returns {number} 实际写入的字节数；若目标空间不足或解压失败（如数据损坏）则返回 0。
 * 
 * @example
 * const compressed = new Uint8Array([...]); // 来自之前的压缩结果
 * const out = new Uint8Array(originalSize);
 * const written = decompressInto(compressed, out, 0, originalSize);
 * console.log(`解压后大小: ${written}`);
 */
export function decompressInto(buffer, target, offset, size) {
  const module = getModule();
  const input = toUint8Array(buffer);
  const targetView = toUint8Array(target);

  if (offset + size > targetView.length) {
    return 0;
  }

  const srcPtr = module._malloc(input.byteLength);
  const destPtr = module._malloc(size);

  try {
    new Uint8Array(module.HEAPU8.buffer, srcPtr, input.byteLength).set(input);
    const resultSize = module._decompress(destPtr, size, srcPtr, input.byteLength);
    if (resultSize === -1) {
      return 0;
    }
    targetView.set(module.HEAPU8.subarray(destPtr, destPtr + resultSize), offset);
    return resultSize;
  } finally {
    module._free(srcPtr);
    module._free(destPtr);
  }
}

export function getModuleForTesting() {
    return getModule();
}
