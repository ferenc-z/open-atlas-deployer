# e2e_trace Graph：用 Builder MCP 在 Studio 里建

这两个文件由 `src/server/services/trace/e2e-graph.ts` 导出。那里改了要重新导出并一起提交：`node bin/export-e2e-graph.ts`。

- `contract.edn`：Graph 契约，约 75 KB。里面的 `:workspace/id "deployer"` 和 `:graph/id "e2e-trace"` 是占位，上传前要换成 Studio 草稿里的真实 id。
- `saved-queries.json`：Deployer 按名字调用的 8 个存好的查询。名字、参数一个都不能改。

## 交给 agent 的话

把两个文件给连着 Studio Builder MCP 的 agent，原样发下面这段（尖括号里的值换成你的）：

```
请用 Studio Builder MCP 建一个给 Open Atlas Deployer 读 e2e_trace 的 Graph。附件 contract.edn 和 saved-queries.json 是 Deployer 导出的，内容不要改写，只做下面第 4 步说的 id 替换。

1. 用 save_credential 存两个凭据：E2E_TRACE_DB_USER = <ClickHouse 只读账号>，E2E_TRACE_DB_PASSWORD = <密码>。
2. 用 declare_source 声明数据源，id 必须是 e2e-trace-ch，verify: true，apply: true：
   {"type": "sql", "label": "ClickHouse e2e_trace", "jdbc_url": "jdbc:clickhouse://<Studio 能连到的 ClickHouse 主机>:8123/e2e_trace", "username": "${E2E_TRACE_DB_USER}", "password": "${E2E_TRACE_DB_PASSWORD}"}
   如果报 id 已存在，带上报错里的 revision 作为 expected_revision 重做。verify 有 error 就停下告诉我。
3. list_graphs 看有没有叫 e2e-trace 的 Graph，没有就 create_graph {"name": "e2e-trace"}。记下它的全名（workspace/e2e-trace）。
4. get_graph 读这个 Graph 的草稿，从草稿文本里取出 :workspace/id 和 :graph/id 的值。把 contract.edn 里所有 "deployer"（workspace id）和 "e2e-trace"（graph id）这两个带引号的字符串换成草稿里的值，然后 upload_graph，expected_revision 用草稿的 revision。有 findings 就停下告诉我。
5. 对 saved-queries.json 里的每一项调 save_saved_query：graph、name、description、eql 原样，有 params 就带上。
6. publish_graph {"graph": <全名>, "apply": true}。除 info、warning 以外有 findings 就停下告诉我。
7. 用数据面试一下 e2e_schedules 这个查询，告诉我返回了几个 schedule。
8. 回报：Graph 全名、发布的版本号、数据源 verify 结果、第 7 步的结果。不用签发 graph token，Deployer 会自己签。
```

## 手动建

步骤和上面一样，在 Studio 页面上逐项做：凭据 `E2E_TRACE_DB_USER` / `E2E_TRACE_DB_PASSWORD` → 数据源 `e2e-trace-ch`（sql，jdbc 指向 `e2e_trace` 库，账号密码写 `${…}` 引用）→ 建 Graph `e2e-trace` → 契约换掉两个占位 id 后整段粘进去保存 → 8 个查询按 `saved-queries.json` 逐个建（名字、参数、eql 原样）→ 发布 → 试跑 `e2e_schedules`。

## 建好以后

在 Deployer 上给需要的服务（NiFi 2.x、按 schedule 调度的）配这个 Graph：admin 调 `PUT /api/services/<服务 id>/trace-sources/e2e_trace`，body `{"graph": "<workspace>/e2e-trace"}`。Deployer 配了 Builder 地址和 workspace token 时会自己签 graph token；返回里的 `check` 说明能不能读到 schedule 定义。

## 前提

- ClickHouse 库名是 `e2e_trace`，有 `rt_dwd_l1_trace_log`、`schedule_header`、`schedule_detail` 三张表（查询里写死了库名）。
- 是 Studio 的容器去连 ClickHouse，不是 Deployer。
- 只在 Studio 2.11.3、ClickHouse 22.8 上测过。
