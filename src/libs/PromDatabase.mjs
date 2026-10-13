import sqlite3 from '@appthreat/sqlite3';
import { promisify } from 'util';
import { PromStatement } from './PromStatement.mjs';

/**
 * 封装 sqlite3.Database，将异步回调方法转为 Promise 风格
 * @example
 * import { PromDatabase, OPEN_READWRITE, OPEN_CREATE } from './prom-database.js';
 * const db = new PromDatabase('./test.db', OPEN_READWRITE | OPEN_CREATE, true);
 * await db.runAsync('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
 * const rows = await db.allAsync('SELECT * FROM users');
 */
export class PromDatabase {
    /**
     * 创建数据库连接
     * @param {string} filename - 数据库文件路径
     * @param {number} [mode] - 打开模式（例如 OPEN_READWRITE | OPEN_CREATE），默认该组合
     * @param {boolean} [verbose=false] - 是否启用详细日志（调试用）
     */
    constructor(filename, mode, verbose = false) {
        // 处理参数重载：若第二个参数是布尔值，则视为 verbose
        if (typeof mode === 'boolean') {
            verbose = mode;
            mode = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
        } else if (mode === undefined) {
            mode = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
        }

        const driver = verbose ? sqlite3.verbose() : sqlite3;
        /** @type {sqlite3.Database} 原生数据库实例，可直接访问 */
        this.db = new driver.Database(filename, mode);

        // ---------- 同步方法（直接绑定） ----------
        /** 按顺序执行回调中的操作（同步） */
        this.serialize = this.db.serialize.bind(this.db);
        /** 允许并行执行回调中的操作（同步） */
        this.parallelize = this.db.parallelize.bind(this.db);
        /** 配置数据库选项（同步） */
        this.configure = this.db.configure.bind(this.db);
        /** 中断当前正在执行的查询（同步） */
        this.interrupt = this.db.interrupt.bind(this.db);
        /**
         * 预编译 SQL 语句，返回 Statement 对象（同步）
         * @returns {sqlite3.Statement}
         */
        this.prepare = (sql, ...params) => {
            const rawStmt = this.db.prepare(sql, ...params);
            return new PromStatement(rawStmt);
        };

        // ---------- 异步方法（转为 Promise） ----------
        /**
         * 执行 INSERT/UPDATE/DELETE 等无结果集的 SQL
         * @param {string} sql - SQL 语句
         * @param {...any} params - 参数（占位符 ? 的值）
         * @returns {Promise<{ lastID: number, changes: number }>}
         *   - lastID: 插入行的自增 ID（若适用）
         *   - changes: 受影响的行数
         */
        this.runAsync = this._promisifyRun.bind(this);

        /**
         * 查询单行记录
         * @template T
         * @param {string} sql - SQL 语句
         * @param {...any} params - 参数
         * @returns {Promise<T | undefined>} 查询结果的第一行，若无则返回 undefined
         */
        this.getAsync = promisify(this.db.get.bind(this.db));

        /**
         * 查询所有行
         * @template T
         * @param {string} sql - SQL 语句
         * @param {...any} params - 参数
         * @returns {Promise<T[]>} 结果数组（可能为空）
         */
        this.allAsync = promisify(this.db.all.bind(this.db));

        /**
         * 执行多条 SQL 语句（批量执行，无结果）
         * @param {string} sql - 可以包含多条语句，用分号分隔
         * @returns {Promise<void>}
         */
        this.execAsync = promisify(this.db.exec.bind(this.db));

        /**
         * 关闭数据库连接
         * @returns {Promise<void>}
         */
        this.closeAsync = promisify(this.db.close.bind(this.db));

        /**
         * 加载 SQLite 扩展
         * @param {string} filename - 扩展文件路径
         * @returns {Promise<void>}
         */
        this.loadExtensionAsync = promisify(this.db.loadExtension.bind(this.db));

        /**
         * 等待所有挂起的操作完成（通常用于测试）
         * @returns {Promise<void>}
         */
        this.waitAsync = promisify(this.db.wait.bind(this.db));

        /**
         * 遍历查询结果（返回所有行和计数）
         * @template T
         * @param {string} sql - SQL 语句
         * @param {...any} params - 参数（可传数组或展开）
         * @returns {Promise<{ rows: T[], count: number }>}
         *   - rows: 所有行
         *   - count: 总行数
         * @note 此方法会一次性收集所有行，不提供逐行回调；若需逐行处理，请使用 allAsync 或原生的 each
         */
        this.eachAsync = this._promisifyEach.bind(this);
    }

    /**
     * 内部：将 db.run 转换为 Promise
     * @private
     */
    _promisifyRun(sql, ...params) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, ...params, function (err) {
                if (err) reject(err);
                else resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }

    /**
     * 内部：将 db.each 转换为 Promise（收集所有行）
     * @private
     */
    _promisifyEach(sql, ...params) {
        return new Promise((resolve, reject) => {
            let resolved = false;
            const rows = [];
            let count = 0;

            // 处理参数：如果传入一个数组则直接使用，否则视为参数列表
            let paramsArray;
            if (params.length === 1 && Array.isArray(params[0])) {
                paramsArray = params[0];
            } else {
                paramsArray = params;
            }

            this.db.each(
                sql,
                paramsArray,
                // 行回调
                (err, row) => {
                    if (err) {
                        if (!resolved) {
                            resolved = true;
                            reject(err);
                        }
                        return;
                    }
                    rows.push(row);
                    count++;
                },
                // 完成回调
                (err, cnt) => {
                    if (resolved) return;
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ rows, count: cnt || count });
                    }
                    resolved = true;
                }
            );
        });
    }

    // ---------- 属性 getter ----------
    /** 数据库连接是否已打开 */
    get open() {
        return this.db.open;
    }

    /** 当前是否处于事务中 */
    get inTransaction() {
        return this.db.inTransaction;
    }
}

// ---------- 导出 sqlite3 常量，方便使用 ----------
export const {
    OPEN_READONLY,
    OPEN_READWRITE,
    OPEN_CREATE,
    OPEN_FULLMUTEX,
    OPEN_SHAREDCACHE,
    OPEN_PRIVATECACHE,
    OPEN_URI,
    VERSION,
    SOURCE_ID,
    VERSION_NUMBER,
    OK,
    ERROR,
    INTERNAL,
    PERM,
    ABORT,
    BUSY,
    LOCKED,
    NOMEM,
    READONLY,
    INTERRUPT,
    IOERR,
    CORRUPT,
    NOTFOUND,
    FULL,
    CANTOPEN,
    PROTOCOL,
    EMPTY,
    SCHEMA,
    TOOBIG,
    CONSTRAINT,
    MISMATCH,
    MISUSE,
    NOLFS,
    AUTH,
    FORMAT,
    RANGE,
    NOTADB,
    LIMIT_LENGTH,
    LIMIT_SQL_LENGTH,
    LIMIT_COLUMN,
    LIMIT_EXPR_DEPTH,
    LIMIT_COMPOUND_SELECT,
    LIMIT_VDBE_OP,
    LIMIT_FUNCTION_ARG,
    LIMIT_ATTACHED,
    LIMIT_LIKE_PATTERN_LENGTH,
    LIMIT_VARIABLE_NUMBER,
    LIMIT_TRIGGER_DEPTH,
    LIMIT_WORKER_THREADS,
    cached,
    RunResult,
    Statement,
    Database,
} = sqlite3;

// 也可单独导出 verbose 函数
export const verbose = sqlite3.verbose.bind(sqlite3);