/**
 * WorkGremlin 插件的**零配置入口** —— OpenCode / Kilo 会自动加载 `.opencode/plugins/` 下的文件。
 *
 * 实现本体在 packages/reporter/src/plugin/index.js（跟 hook.js 放在一起，便于一起维护和测试）；
 * 这里只做转发。想全机生效就在 `~/.config/opencode/opencode.json` 的 `plugins` 数组里直接写
 * 那个文件的路径（Kilo 同理用 `~/.config/kilo/kilo.jsonc`）。
 *
 * 装上之后 8F OpenCode 楼层的相位就从「轮询推断、UI 灰显」变成「上报真值、不灰显」，
 * 并且多出一个轮询给不出的相位：「等待授权」。没装插件 8F 照常工作，见 server/src/opencode.js。
 */
export { default } from "../../packages/reporter/src/plugin/index.js"
