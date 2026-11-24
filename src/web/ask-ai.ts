// What Ask AI is told and offers on each page (pages-rethink §10.2.2 "Ask AI 抽屉", §10.3 P6).
// The page name goes into the Workbench chat's page context as `page`; the service, flow, analysis and to-do ids come with it
// from usePageFocus (focus.ts). There is no way to pre-fill the chat's input (P6), so the suggestions are examples to copy.

/** The `page` of the context: the service page and the overview are both "service" (AskContext), the others keep their name. */
export const contextPage = (tab: string): string => (tab === "services" ? "service" : tab);

/** "Try asking": static examples per page (the people asking write Chinese; the AI answers in Chinese). */
export const SUGGESTIONS: Record<string, string[]> = {
  services: [
    "这个服务为什么是这个状态？",
    "某个文件现在到哪了？",
    "改这个设置会有什么影响？",
    "这台机器出的问题影响了哪些业务？",
  ],
  businesses: [
    "哪条业务现在最需要处理？",
    "我想登记一条新业务",
    "有哪些公共模块，被哪些业务用？",
  ],
  register: [
    "我要登记一条业务，link 在下面",
    "这个组在画布上和别的组没有连线，数据是从哪来的？",
    "这个组接上了公共模块吗？",
  ],
  flow: [
    "这条业务最近有没有文件被丢掉？",
    "昨晚 2 点有没有文件没进库？",
    "再加一个组：（贴 link）",
  ],
};
