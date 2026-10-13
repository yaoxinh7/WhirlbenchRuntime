import UniversalFile from "./libs/UniversalFile.cjs";
import CurvePlayer,{EasingGenerator} from "./libs/CurvePlayer.mjs";
import WTimmer from "./libs/wtimmer.mjs";
//import OverlayManager from "./libs/overlay/OverlayManager.js";

class runtime {

    file=UniversalFile;
    CurvePlayer=CurvePlayer;
    WTimmer=WTimmer;

    EasingGenerator=EasingGenerator;


    startOf2000 = new Date('2000-01-01T00:00:00Z').getTime();

    randomBetween(a, b) {
        const min = Math.min(a, b);
        const max = Math.max(a, b);
        if (Number.isInteger(a) && Number.isInteger(b)) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        } else {
            return Math.random() * (max - min) + min;
        }
    }

    removeFast(arr, index) {
        for (let i = index; i < arr.length - 1; i++) {
            arr[i] = arr[i + 1];
        }
        arr.length--;
        return arr;
    }

    getDaysSince2000() {
        const now = Date.now();
        const diffInMs = now - this.startOf2000;
        return diffInMs / (1000 * 60 * 60 * 24);
    }

    strconcat(str1, str2) {
        str1 = String(str1);
        return str1.concat(str2);
    }

    strlength(str) {
        return String(str).length;
    }

    isinclude(str, substr) {
        // 边界处理：如果参数不是字符串，先转为字符串（Scratch 会自动转换）
        const mainStr = String(str);
        const searchStr = String(substr);

        // Scratch 语义：任何字符串都包含空字符串
        if (searchStr === "") {
            return true;
        }

        // 使用 includes 进行区分大小写的包含判断
        return mainStr.includes(searchStr);
    }

    letter_of(str, lete) {
        //console.log(String(str));
        if (str == undefined) {
            return "";
        }
        return str[lete - 1];
    }

    constructor({ isBackend }) {
        this.keys = new Set();
        this.init(isBackend);
    }

    init({ isBackend }) {
        // 后端环境 或 非浏览器环境 → 直接返回，避免报错
        if (isBackend || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
            return;
        }

        // 规范化按键字符串：字母转小写，空格保持原样
        const normalizeKey = (rawKey) => {
            if (rawKey.length === 1 && /[a-zA-Z]/.test(rawKey)) {
                return rawKey.toLowerCase();
            }
            return rawKey;
        };

        globalThis.addEventListener('keydown', (e) => {
            const normKey = normalizeKey(e.key);
            this.keys.add(normKey);
            this.keys.add(e.code);          // 保留物理码，用于需要区分左右键的场景
        });

        globalThis.addEventListener('keyup', (e) => {
            const normKey = normalizeKey(e.key);
            this.keys.delete(normKey);
            this.keys.delete(e.code);
        });
    }

    isPressed(key) {
        // 特殊键映射（键名已全小写）
        const specialKeys = {
            'space': ' ',
            'ctrl': 'Control',
            'alt': 'Alt',
            'shift': 'Shift',
            'enter': 'Enter',
            'backspace': 'Backspace',
            'delete': 'Delete',
            'insert': 'Insert',
            'home': 'Home',
            'end': 'End',
            'page up': 'PageUp',
            'page down': 'PageDown',
            'up arrow': 'ArrowUp',
            'down arrow': 'ArrowDown',
            'left arrow': 'ArrowLeft',
            'right arrow': 'ArrowRight',
            'tab': 'Tab',
            'caps lock': 'CapsLock',
            'f1': 'F1', 'f2': 'F2', 'f3': 'F3', 'f4': 'F4',
            'f5': 'F5', 'f6': 'F6', 'f7': 'F7', 'f8': 'F8',
            'f9': 'F9', 'f10': 'F10', 'f11': 'F11', 'f12': 'F12'
        };

        const lowerKey = key.toLowerCase();
        // 1. 特殊映射
        const mappedKey = specialKeys[lowerKey] || lowerKey;
        if (this.keys.has(mappedKey)) return true;

        // 2. 字母按键：同时支持物理码（如 'KeyA'）
        if (lowerKey.length === 1 && /[a-z]/.test(lowerKey)) {
            const code = 'Key' + lowerKey.toUpperCase();
            if (this.keys.has(code)) return true;
        }

        return false;
    }

    Infcheck(n) {
        if (n === Infinity || n === -Infinity || isNaN(n)) {
            return 0;
        }
        return n;
    }

}
export default runtime;