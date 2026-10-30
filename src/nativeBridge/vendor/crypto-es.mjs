// crypto-es.mjs：crypto-js 的 ESM 出口壳。上游（folia-sonnet）把 crypto-js 的 UMD 源码
// 整份内嵌在扩展里；这里它的主体与 npm 的 crypto-js 4.2.0 逐字节一致，所以只保留壳、
// 从依赖里取同一份库（版本钉死在 package.json）。网易 weapi/eapi 的加密入口都经这一层。
export { default } from 'crypto-js';
