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
    "某条业务流程识别得不对",
  ],
  flows: [
    "这两个流程组为什么被合成一条业务？",
    "这条业务其实应该拆成两条",
    "哪些流程组可以不用管？",
  ],
  flow: [
    "这条业务最近有没有文件被丢掉？",
    "昨晚 2 点有没有文件没进库？",
    "卡住的时间设多少合适？",
  ],
};
