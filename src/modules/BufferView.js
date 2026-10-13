import keyMirror from 'keymirror';

//常量部分

const _Encoder = new TextEncoder();
const _Decoder = new TextDecoder();

export const ViewSizes = keyMirror({
    Int8: null,
    Uint8: null,
    Int16: null,
    Uint16: null,
    Int32: null,
    Uint32: null,
    Float32: null,
    BigInt64: null,
    BigUint64: null,
    Float64: null
})

function numberSize(type) {
    switch (type) {
        case ViewSizes.Int8:
        case ViewSizes.Uint8:
            return 1;
        case ViewSizes.Int16:
        case ViewSizes.Uint16:
            return 2;
        case ViewSizes.Int32:
        case ViewSizes.Uint32:
        case ViewSizes.Float32:
            return 4;
        case ViewSizes.BigInt64:
        case ViewSizes.BigUint64:
        case ViewSizes.Float64:
            return 8;
        default:
            return 0;
    }
}

export function ByteNumber(key, type) {
    const size = numberSize(type);
    if (size === 0) return null;
    return {
        key,
        size,
        type
    }
}

export function ByteString(key) {
    return {
        key,
        type: 'string'
    }
}

/**
 * 创建一个对象程序对象
 * @param {string} key - 获取编码对象的程序 
 * @param {Array} childCmd - 子程序列表 
 * @returns {Object} - 程序对象
 */
export function ByteObject(key,childCmd) {
    return {
        key,
        type: 'object',
        childCmd
    }
}

export function newCmd() {
    //诈骗函数:) 看着舒服就行
    return [];
}

//读部分

export class BufferParser {
    constructor() {
        this.parsed = false;
        this.error = null;
    }

    /**
     * 将二进制解析到现有对象
     * @param {Array} Commands - 命令
     * @param {ArrayBuffer} Buffer - 二进制
     * @param {Object} Target - 目标对象
     * @throws {TypeError} - 解析错误
     * @throws {RangeError} - 解析错误(超索引)
     */
    parseInto(Commands, Buffer, Target, Offset = 0, View = undefined) {
        if (typeof View === 'undefined'){
            View = new DataView(Buffer);
        }
        let pointer = Offset;

        for (const cmd of Commands) {
            switch (cmd.type) {
                case 'object':
                    const objSize = View.getUint32(pointer);
                    if (objSize === 0) {
                        throw new TypeError('对象解析失败(空对象)' + cmd);
                    }
                    if (objSize + pointer > Buffer.byteLength) {
                        throw new RangeError('对象解析失败(超索引)' + cmd);
                    }
                    pointer+=4;
                    //检查子目标键是否存在
                    if (typeof Target[cmd.key] !== 'object'){
                        //未初始化 进行初始化
                        Target[cmd.key]={};
                    }
                    //直接递归 让函数写进去
                    this.parseInto(cmd.childCmd,Buffer,Target[cmd.key],pointer,View);
                    
                    break;
                case 'string':
                    const textSize = View.getUint32(pointer);
                    if (textSize === 0) {
                        throw new TypeError('文本解析失败(空文本)' + cmd);
                    }
                    if (textSize + pointer > Buffer.byteLength) {
                        throw new RangeError('文本解析失败(超索引)' + cmd);
                    }
                    pointer += 4;
                    const textView = new Uint8Array(Buffer, pointer, textSize);
                    const textDecoded = _Decoder.decode(textView);
                    //将文本挂到目标
                    Target[cmd.key] = textDecoded;
                    pointer += textSize;
                    break;
                default:
                    const num = View['get' + cmd.type](pointer);
                    if (typeof num === 'undefined') {
                        throw new TypeError('数字解析失败' + cmd);
                    }
                    //将数字挂到目标
                    Target[cmd.key] = num;
                    pointer += numberSize(cmd.type);
                    break;
            }
        }
    }
    parse(Commands, Buffer) {
        const Target = {};
        this.parseInto(Commands, Buffer, Target);
        return Target;
    }

}

//写部分

//如果直接用这个类 用户自己分配ArrayBuffer 0拷贝
export class BufferPen {
    reHandle(Buffer) {
        this.Buffer = Buffer;
        this.pointer = 0;
        this.view = new DataView(Buffer);
    }
    writeNumber(value, type, littleEndian = false) {
        if (typeof value !== 'number') {
            throw new TypeError('写数字只能写入数字!');
        }
        const size = numberSize(type);
        if (size === 0) {
            throw new TypeError('类型错误!');
        }
        if (this.pointer + size > this.view.byteLength) {
            throw new RangeError('缓冲区空间不足');
        }

        if (typeof type !== 'string') {
            throw new TypeError('必须指定写入类型');
            //已弃用 尝试自动分配类型(无法对齐)
            /*
                if (value === 0) {
                    type = ViewSizes.Uint8;
                }
                if (Number.isInteger(value)) {
                    //至少保证两位小数
                    if (value > 131072) {
                        type = ViewSizes.Float64;
                    } else {
                        type = ViewSizes.Float32;
                    }
                }
                else {
                    const biggerThan0 = value > 0;
                    if (biggerThan0) {
                        if (value <= 255) {
                            type = ViewSizes.Uint8;
                        }
                        else if (value <= 65535) {
                            type = ViewSizes.Uint16;
                        }
                        else if (value <= 4294967295) {
                            type = ViewSizes.Uint32;
                        }
                        else {
                            type = ViewSizes.BigUint64;
                        }
                    }
                    else {
                        if (value >= -128) {
                            type = ViewSizes.Int8;
                        }
                        else if (value >= -32768) {
                            type = ViewSizes.Int16;
                        }
                        else if (value >= -2147483648) {
                            type = ViewSizes.Int32;
                        }
                        else {
                            type = ViewSizes.BigInt64;
                        }
                    }
                }
            */
        }
        try {
            this.view['set' + type](this.pointer, value, littleEndian);
            this.pointer += size;
        }
        catch (error) {
            if (error instanceof RangeError) {
                console.error('缓冲区撑爆了! 未写入', error);
            }
        }
    }
    /** 
    * 推入一段数据
    * @param {ArrayBufferView} source - 拷贝来源(不要大于2^32 bytes)
    */
    writeBytes(source) {
        const size = source.byteLength;
        if (size <= 0) {
            throw new TypeError('写入空字符or错误?');
        };
        if (this.pointer + size + 4 > this.view.byteLength) {
            throw new RangeError('缓冲区空间不足');
        }
        //写入块大小
        this.writeNumber(size, ViewSizes.Uint32);
        //写入数据
        const targetView = new Uint8Array(this.Buffer, this.pointer, size);
        targetView.set(source);
        //移动指针
        this.pointer += size;
    }
}

export class BufferWriter {
    /**
     * 
     * @param {number} maxDepth - 最大对象层数 越大占用内存也越多 默认最多3层 避免浪费 按需分配
     */
    constructor(maxDepth = 3) {
        this.pen = [];
        for (let i = 0; i < maxDepth; i++) {
            this.pen.push(new BufferPen());
        }
    }
    /**
     * 封装式的生成二进制
     * @param {Array} Commands - 程序列表
     * @param {Object} Target - 输入对象
     * @param {number} Depth - 当前深度
     */
    write(Commands, Target, Depth = 0) {
        //步骤1 解析command的文本&&算大小
        let size = 0;
        const tempValue = {};
        for (const cmd of Commands) {
            switch (cmd.type) {
                case 'object':
                    //递归 先把子Buffer搞出来
                    const childObj=Target[cmd.key];
                    if (typeof childObj !== 'object'){
                        throw new TypeError('对象程序只能用来处理对象!');
                    }
                    const childPaper=this.write(cmd.childCmd,childObj,Depth+1);
                    //算子字节大小
                    if (!(childPaper instanceof ArrayBuffer)){
                        throw new TypeError('创建子对象二进制失败');
                    }
                    const childSize=childPaper.byteLength;
                    //console.log(childPaper)
                    //挂载缓存
                    tempValue[cmd.key]=childPaper;
                    size+=4;
                    size+=childSize;
                    break;

                case 'string':
                    //算文本size+存缓存
                    const str = Target[cmd.key];
                    if (typeof str !== 'string') {
                        //直接抛错终止代码流 必须对齐 否则出来的值是错的
                        throw new TypeError('文本值不存在', cmd.key);
                    }
                    //编码文本
                    const encodedText = _Encoder.encode(str);
                    const textSize = encodedText.byteLength;
                    if (textSize === 0 || typeof textSize === 'undefined') {
                        throw new TypeError('空字符串/非法字符串', cmd);
                    }
                    //挂载 以方便直接用
                    tempValue[cmd.key] = encodedText;
                    //cmd.value = encodedText;
                    //cmd.size = textSize;

                    size += 4;
                    size += textSize;
                    break;

                default:
                    //读要写入的值
                    const num = Target[cmd.key];
                    if (typeof num === 'undefined') {
                        console.warn('数字值不存在 替换为0 key:', cmd.key);
                        num = 0;
                    }
                    //挂载 以方便直接用
                    //cmd.value = num;
                    tempValue[cmd.key] = num;
                    //加上即可
                    const tmpSize = numberSize(cmd.type);
                    if (tmpSize === 0) {
                        throw new TypeError('cmd type解析失败 请检查!', cmd);
                    }
                    //console.log(size);
                    size += tmpSize;
            }

        }
        //创建缓冲区
        //const pointer=0;
        const paper = new ArrayBuffer(size);
        this.pen[Depth].reHandle(paper);
        //开始写数据
        for (const cmd of Commands) {
            //console.log('pointer:',this.pen[Depth].pointer);
            switch(cmd.type){
                case 'object':
                    this.pen[Depth].writeBytes(new Uint8Array(tempValue[cmd.key]));
                    break;
                case 'string':
                    this.pen[Depth].writeBytes(tempValue[cmd.key]);
                    break;
                default:
                    this.pen[Depth].writeNumber(tempValue[cmd.key], cmd.type);
                    break;
            }
                
            //console.log('pointerWorten:',this.pen[Depth].pointer,tempValue[cmd.key]);
        }
        return paper;
    }
}