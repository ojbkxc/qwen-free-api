// 国内版（qianwen.com 网页版）支持的模型列表，与 chat.ts 的 resolveModel 保持一致
const MODELS = [
  { id: "qwen", object: "model" },
  { id: "qwen3.6-flash", object: "model" },
  { id: "qwen3.7-max", object: "model" },
  { id: "qwen3.8-max", object: "model" },
];

export default {
  prefix: "/v1/models",

  get: {
    "": async () => ({
      object: "list",
      data: MODELS,
    }),
  },
};