// export.js
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');
const assetsSrc = path.join(__dirname, 'assets');
const assetsDest = path.join(distDir, 'assets');

function copyDirectorySync(src, dest) {
  // 解析为绝对路径（基于当前工作目录）
  const srcPath = path.resolve(src);
  const destPath = path.resolve(dest);

  // 创建目标目录（如果不存在则创建，支持递归创建）
  fs.mkdirSync(destPath, { recursive: true });

  // 读取源目录内容，并附带文件类型信息
  const entries = fs.readdirSync(srcPath, { withFileTypes: true });

  for (const entry of entries) {
    const srcEntry = path.join(srcPath, entry.name);
    const destEntry = path.join(destPath, entry.name);

    if (entry.isDirectory()) {
      // 递归复制子目录
      copyDirectorySync(srcEntry, destEntry);
    } else if (entry.isFile()) {
      // 复制文件（会覆盖目标文件）
      fs.copyFileSync(srcEntry, destEntry);
    }
    // 忽略符号链接等其它类型（可根据需要扩展）
  }
}

copyDirectorySync('./runtime', './dist/runtime', { recursive: true });

// 复制文件夹
function copyDir(src, dest) {
    if (!fs.existsSync(src)) return;
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (let entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}
copyDir(assetsSrc, assetsDest);
console.log('Assets copied.');

// 生成 NW.js package.json
const pkg = {
    name: "babylon-scratch-stage",
    main: "index.html",
    version: "1.0.0",
    window: {
        title: "Babylon Scratch Stage",
        width: 820,
        height: 640,
        resizable: true,
        fullscreen: false
    },
    "chromium-args": "--allow-file-access-from-files --enable-unsafe-webgpu",
    nodejs: true
};
fs.writeFileSync(path.join(distDir, 'package.json'), JSON.stringify(pkg, null, 2));
console.log('package.json generated.');

`const pkg = {
    name: "babylon-scratch-stage",
    version: "1.0.0",
    main: "electron.js",        // 入口指向 Electron 主进程文件
    // 可选：添加一些 Electron 打包需要的字段
    "private": true,
    "type": "commonjs"
};
fs.writeFileSync(path.join(distDir, 'package.json'), JSON.stringify(pkg, null, 2));
console.log('package.json generated.');



const electronMain = \`
const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow;

async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 820,
        height: 640,
        resizable: true,
        webPreferences: {
            nodeIntegration: true,      // 允许渲染进程使用 Node (如果不需要可关闭)
            contextIsolation: false,    // 方便调试
            webgl: true,
            enableWebGPU: true          // 启用 WebGPU
        }
    });

    // 加载 dist 目录下的 index.html
    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // 打开开发者工具（开发时方便）
    mainWindow.webContents.openDevTools();

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
\`;

fs.writeFileSync(path.join(distDir, 'electron.js'),electronMain );
console.log('electronmain generated.');
`