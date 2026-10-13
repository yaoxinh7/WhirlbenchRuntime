/**
 * 封装 sqlite3.Statement，将异步回调方法转为 Promise 风格
 * @example
 * import { PromStatement } from './prom-statement.js';
 * const stmt = db.prepare('INSERT INTO users (name) VALUES (?)');
 * const promStmt = new PromStatement(stmt);
 * await promStmt.runAsync('Alice');
 * const result = await promStmt.getAsync('SELECT * FROM users WHERE id = ?', 1);
 * await promStmt.finalizeAsync();
 */
export class PromStatement {
    /**
     * 包装一个原始的 sqlite3.Statement 实例
     * @param {import('@appthreat/sqlite3').Statement} stmt - 原始 Statement 对象
     */
    constructor(stmt) {
        /** @type {import('@appthreat/sqlite3').Statement} 原始 Statement 实例，可直接访问其属性和方法 */
        this.stmt = stmt;
    }

    // ---------- 异步方法（Promise 风格） ----------

    /**
     * 绑定参数到预编译语句（异步完成）
     * @param {...any} params - 要绑定的参数值（个数需与占位符匹配）
     * @returns {Promise<void>}
     * @example
     * await promStmt.bindAsync('Alice', 30);
     * // 之后可直接调用 runAsync() 无需再传参
     */
    bindAsync(...params) {
        return new Promise((resolve, reject) => {
            this.stmt.bind(...params, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * 重置语句状态，使其可以再次执行（异步）
     * @returns {Promise<void>}
     * @example
     * await promStmt.resetAsync();
     */
    resetAsync() {
        return new Promise((resolve, reject) => {
            this.stmt.reset((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * 最终化并释放语句资源（异步），调用后语句不可再用
     * @returns {Promise<void>}
     * @example
     * await promStmt.finalizeAsync();
     */
    finalizeAsync() {
        return new Promise((resolve, reject) => {
            this.stmt.finalize((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * 执行语句（适用于 INSERT/UPDATE/DELETE 等无结果集的 SQL）
     * @param {...any} params - 可选参数，若已绑定则可不传
     * @returns {Promise<{ lastID: number, changes: number }>}
     *   - lastID: 插入行的自增 ID（若适用）
     *   - changes: 受影响的行数
     * @example
     * const { lastID, changes } = await promStmt.runAsync('Alice', 30);
     */
    runAsync(...params) {
        return new Promise((resolve, reject) => {
            this.stmt.run(...params, function (err) {
                if (err) reject(err);
                else resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }

    /**
     * 查询单行记录
     * @template T
     * @param {...any} params - 可选参数
     * @returns {Promise<T | undefined>} 第一行数据对象，若无则返回 undefined
     * @example
     * const user = await promStmt.getAsync(1);
     */
    getAsync(...params) {
        return new Promise((resolve, reject) => {
            this.stmt.get(...params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    /**
     * 查询所有行
     * @template T
     * @param {...any} params - 可选参数
     * @returns {Promise<T[]>} 结果数组（可能为空）
     * @example
     * const users = await promStmt.allAsync();
     */
    allAsync(...params) {
        return new Promise((resolve, reject) => {
            this.stmt.all(...params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    /**
     * 遍历并收集所有行（一次性返回全部，与 allAsync 类似但返回结构包含计数）
     * @template T
     * @param {...any} params - 可选参数
     * @returns {Promise<{ rows: T[], count: number }>}
     *   - rows: 所有行数组
     *   - count: 总行数
     * @note 此方法会收集所有行到内存，适合数据量不大的场景；若需逐行处理，请直接使用原始 stmt.each
     * @example
     * const { rows, count } = await promStmt.eachAsync();
     */
    eachAsync(...params) {
        return new Promise((resolve, reject) => {
            const rows = [];
            let count = 0;
            let resolved = false;

            // 处理参数：如果传入一个数组则直接使用，否则视为参数列表
            let paramsArray;
            if (params.length === 1 && Array.isArray(params[0])) {
                paramsArray = params[0];
            } else {
                paramsArray = params;
            }

            const rowCallback = (err, row) => {
                if (err) {
                    if (!resolved) {
                        resolved = true;
                        reject(err);
                    }
                    return;
                }
                rows.push(row);
                count++;
            };

            const completeCallback = (err, cnt) => {
                if (resolved) return;
                if (err) reject(err);
                else resolve({ rows, count: cnt || count });
                resolved = true;
            };

            // stmt.each 的重载：either (callback, complete) 或 (params, callback, complete)
            if (paramsArray && paramsArray.length > 0) {
                this.stmt.each(paramsArray, rowCallback, completeCallback);
            } else {
                this.stmt.each(rowCallback, completeCallback);
            }
        });
    }
}