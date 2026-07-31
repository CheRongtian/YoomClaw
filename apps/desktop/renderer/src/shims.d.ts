// 环境声明（ambient）。本文件不能出现顶层 import/export，
// 否则会变成模块，下面的 declare module 会退化成"模块增强"而失效。

// rehype-katex 不自带类型声明
declare module "rehype-katex";
