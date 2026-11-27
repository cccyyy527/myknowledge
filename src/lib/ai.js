// AI 接入：OpenAI 兼容的 /chat/completions
// key 只存本机 localStorage，和云同步 token 同一套信任模型
// 实现按职责拆在 ./ai/ 下，这里只做统一出口，调用方照旧 from '../lib/ai.js'
export * from './ai/client.js'
export * from './ai/topics.js'
export * from './ai/schema.js'
export * from './ai/prompts.js'
export * from './ai/block-edit.js'
export * from './ai/compose.js'
export * from './ai/ask.js'
export * from './ai/agent.js'
export * from './ai/ocr.js'
export * from './ai/revise.js'
