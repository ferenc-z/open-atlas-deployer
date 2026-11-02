# Open Atlas Deployer

独立的部署控制应用（设计见 owner 知识库 `designs/open-atlas-deployer.md`）。现在完成了：

- 阶段 0：由部署清单生成服务器的 compose 文件；
- 阶段 1：骨架，即 Workbench 会话认人、Groups 授权、紧急账号、应用注册表、只读状态页；
- 阶段 2：宿主机执行器（[executor/](executor/)），以及 `compose-service` 驱动、构建、部署、自动回滚、回到旧版、审计（见下面"阶段 2"一节）；
- 阶段 3：环境变量管理，包括加密保存、版本、校验、写入服务器、UAT / PROD 对比（见下面"阶段 3"一节）；
- 阶段 4：制品库、晋级规则，以及 PROD 的 Deployer 用只读 key 查 UAT 的记录（见下面"阶段 4"一节）；
- 阶段 5：其余驱动（`workbench-app`、`studio-graph`、`oma-agent`、`db-migration`、`manual`）、Release 附件（bundle）、契约核对，一个应用的全部组件一次部署（见下面"阶段 5"一节）；
- 阶段 6：API key 与 `/mcp`、页面旁的 Deploy Assistant（Workbench 嵌入对话 + 卡片）、部署失败后经 OMA 自动诊断（见下面"阶段 6"一节）；
- 阶段 7：接入评估（给一个仓库地址）和新版本的清单评估（D27）（见下面"阶段 7"一节）；
- 阶段 8：部署前在 Workbench 通知用户（W3）、漂移检测、每日简报（见下面"阶段 8"一节）。

阶段 5 起，Workbench 应用包、Agent、数据库迁移、Graph、人工步骤都有驱动，Logbook 这样由几种组件组成的应用也能一次部署。

## 阶段 1：骨架

```sh
npm install
npm run build:web                       # 页面 → dist/web
node bin/import-manifests.ts data ../open-atlas-docs/docs/proposals/deploy-manifests   # 导入四份初始清单
cp examples/uat.environment.json data/environment.json
DEPLOYER_WORKBENCH_URL=http://workbench:8090 npm start   # http://<host>:8095/deploy/
npm test && npm run typecheck
```

Node 22.18 起直接运行 `.ts`（类型剥离），服务端不需要构建；状态库用 Node 自带的 `node:sqlite`（`data/deployer.db`）。

### 设置

| 变量 | 缺省 | 含义 |
|---|---|---|
| `DEPLOYER_WORKBENCH_URL` | 必填 | Deployer 访问 Workbench 的地址（compose 网络里如 `http://workbench:8090`） |
| `DEPLOYER_WORKBENCH_PUBLIC_URL` | `/` | 未登录时页面上"前往 Workbench 登录"的链接 |
| `DEPLOYER_BASE_PATH` | `/deploy` | 反向代理挂载的路径，与 Workbench 同域名（§9.1）；构建页面时也读它 |
| `DEPLOYER_BIND` / `DEPLOYER_PORT` | `0.0.0.0` / `8095` | |
| `DEPLOYER_DATA` | `./data` | 状态库目录 |
| `DEPLOYER_ENVIRONMENT_FILE` | `<data>/environment.json` | 本环境设置的初始文件：名称、登记的镜像仓库、每个应用的版本（格式同 [examples/uat.environment.json](examples/uat.environment.json)）。2026-11-02 起（D38）只在第一次启动时导入为状态库里的修订 1，之后在"Environment settings"页或 MCP 工具里改，文件不再读 |
| `DEPLOYER_GITHUB_TOKEN_FILE` | 无 | GitHub 只读令牌，用来列出私有仓库的 tag，供选择版本 |
| `DEPLOYER_OBSERVE_URLS` | 无 | JSON，服务名 → 地址；只在 compose 网络之外开发时用 |
| `DEPLOYER_EMERGENCY_PASSWORD_HASH` | 无 | 紧急账号，`node bin/hash-password.ts` 从标准输入读密码生成；不设就没有紧急账号 |
| `DEPLOYER_SECURE_COOKIES` | `true` | 紧急会话 cookie 带 `Secure` |
| `DEPLOYER_CREDENTIAL_ENCRYPTION_KEY` | 无 | 32 字节、base64（`openssl rand -base64 32`），加密 env 里的密钥；不设就不启用环境变量管理。丢了它，库里的密钥就解不开了，要和状态库分开备份 |
| `DEPLOYER_COMPARE_KEY` | 无 | UAT 与 PROD 的 Deployer 设成同一个值，对比时密钥才能比出"相同 / 不同"；不设只能看出两边是否都设置了 |
| `DEPLOYER_TEMPLATES_DIR` | `./templates` | Deployer 自己的 env 模板（清单 `env.template`） |
| `DEPLOYER_PEER_KEY_SHA256` | 无 | UAT 设：PROD 的 Deployer 所持只读 key 的 SHA-256（可多个，空格分隔）；不设就没有 `/api/peer/*` |
| `DEPLOYER_UAT_URL` / `DEPLOYER_UAT_KEY_FILE` | 无 | PROD 设：UAT 的 Deployer 地址（含 base path，如 `http://uat-host:8095/deploy`），以及存只读 key 的文件（600）。key 用 `node bin/peer-key.ts` 生成 |
| `DEPLOYER_WORKBENCH_API_KEY_FILE` | 无 | Workbench Administration → API keys 里的一把 key（文件 600），`workbench-app`、`oma-agent` 用它装应用包、把 Business Agent 指向新 agent |
| `DEPLOYER_STUDIO_BUILDER_URL` / `DEPLOYER_STUDIO_TOKEN_FILE` | 无 | Studio Builder MCP（如 `https://studio:9631/mcp`）和 workspace token（`oaw_v1.`，read + write），给 `studio-graph`。Studio 是自签证书时用 `NODE_EXTRA_CA_CERTS` 指向它的证书 |
| `DEPLOYER_OMA_BUILDER_URL` / `DEPLOYER_OMA_BUILDER_KEY_FILE` | 无 | OMA Builder MCP 和它的 `BUILDER_MCP_API_KEY`，给 `oma-agent` |
| `DEPLOYER_OMA_URL` / `DEPLOYER_OMA_API_KEY_FILE` | 无 | 可选：OMA 的 API 和 key，发布后归档更早的同名 agent；不设就不归档 |
| `DEPLOYER_OMA_APPLICATION_ID` / `DEPLOYER_OMA_AGENT` / `DEPLOYER_OMA_ENVIRONMENT` / `DEPLOYER_OMA_VAULTS` | 无 | 接法 B：Deployer 自己开 OMA Session（失败诊断）用的 Application、Agent（Deploy Assistant 的 agent id）、Environment、Vault（放只读服务 key）。配了 `DEPLOYER_OMA_URL`、`DEPLOYER_OMA_API_KEY_FILE`、`DEPLOYER_OMA_AGENT` 才诊断 |
| `DEPLOYER_OMA_ASSESSOR_AGENT` / `DEPLOYER_OMA_ASSESSOR_ENVIRONMENT` / `DEPLOYER_OMA_ASSESSOR_VAULTS` | 无 | 接入评估：Onboarding Assessor 的 agent id、**隔离的** Environment（只放行 git 站点和 Deployer MCP）、Vault（服务 key、私有仓库只读令牌）。不配就不能评估 |
| `DEPLOYER_ISSUE_REPO` / `DEPLOYER_ISSUE_TOKEN_FILE` | 无 | 开 Issue 的 Deployer 仓库（owner/name）和 fine-grained token（只有 Issues: write） |
| `DEPLOYER_BRIEF_HOUR` | `8` | 每日简报在这个钟点之后生成（服务器时间） |
| `DEPLOYER_RELEASE_REPO` / `DEPLOYER_RELEASE_TAG` | 无 / `v{version}` | D39：Overview 上 Deployer 版本下拉框的来源，写成 `github:owner/name`（以后加 `bitbucket:`）；不设就手填版本 |
| `DEPLOYER_GITHUB_API` | `https://api.github.com` | Deployer 读的 GitHub API：列 tag、查 Release、下载附件、读 `release.json` 和 `.env.example`（测试或本地试用时换成替身）；执行器对应 `EXECUTOR_GITHUB_API` |

### 认人与授权（§9）

- 每个请求都把浏览器带来的 Workbench cookie（只转发 `open_atlas_workbench_session` 与 `open_atlas_workbench_csrf`）发给 Workbench `GET /api/workbench/session`，用 W1 返回的 `groups` 授权。用户被停用、移出组，下一个请求就生效。
- 权限：`deploy-viewer` / `deploy-uat` / `deploy-prod` 任一能看；`deploy-uat`、`deploy-prod` 分别能部署对应环境（阶段 2 起用到）；Workbench 管理员全部权限，并且能维护注册表、看审计。不在任何一个组里的人看到"没有权限"。
- 修改类请求要带 `x-csrf-token`，值是 Workbench 会话的 `csrfToken`。
- Workbench 没有响应（连不上或 5xx）时，沿用 15 分钟内确认过的结果，页面顶部提示；Workbench 明确回答 401 时立即失效（§9.3）。
- 管理员在 Workbench 里以别人的身份操作（act-as）时，权限按被代入的人算，页面上标出。

### 紧急账号（§9.3）

- 只在 Workbench 连不上时可用：登录前和每个请求都检查 Workbench `/health`，结果缓存 15 秒；Workbench 一恢复，紧急会话就不再被接受。
- 密码只以 scrypt 哈希放在宿主机 env 文件里。失败 5 次后锁 15 分钟。会话 1 小时，cookie `HttpOnly; SameSite=Strict`，令牌只存 SHA-256。
- 登录、登录失败、退出、所有修改都记审计，页面顶部一直显示红色提示。

### 应用注册表（§4.3、§4.4、D27）

- 注册表里每个应用只记应用名、显示名、仓库（取自清单的 `release.repo`）和它的清单；服务名、env 文件都在清单里。
- 第一份清单就是登记。之后的清单不能换仓库，要换得先移除再重新登记，所以注册表是白名单，不接受任意地址。
- 保存清单前按格式 v1 校验（`schema/` 里是 open-atlas-docs 那份 schema 的副本）。另外检查依赖存在、没有环，以及服务名、宿主机端口不和其他已登记应用冲突。
- 每次保存是新的一版；改 `appliesFrom` 就从新版本起另立一份，按 `appliesFrom` 覆盖到下一份为止。历史可查看，可导出为 `deploy.json`。
- 移除只做标记，清单历史保留。页面上管理员粘贴 JSON 保存；逐项配置的表单以后再做。

### 状态页：每个环境跑着什么

Deployer 容器不挂 Docker socket（§8.2），所以状态有两个来源：

1. **宿主机容器列表**：执行器每 30 秒用 `docker ps` 导出本 compose 项目的容器，写成 JSON 行（先写临时文件再改名），Deployer 以只读方式挂载读取。文件超过 5 分钟没更新，页面标为"已过期"。阶段 1 时这件事由一个 cron 脚本做，阶段 2 已由执行器接手。

2. **应用自报的版本**：只问自己构建的镜像（`company-registry`）。在 compose 网络里依次访问 `http://<服务名>:<容器端口>/meta/contracts`，读到的是镜像里的 `BUILD.json`（版本、commit、provides），结果缓存 30 秒。公共镜像不问。

按组件对照期望版本给出判断：

| 判断 | 含义 |
|---|---|
| 正常 | 在运行，有健康检查的是 healthy；标签版本与自报版本都和期望一致，或都没有 |
| 版本不符 | 标签 `org.open-atlas.version` 或自报版本与期望不同 |
| 启动中 / 异常 | 健康检查还在 starting / 容器没在运行或 unhealthy |
| 没有容器 | 清单里的服务在宿主机上找不到 |
| 未知 | 没有宿主机状态，也没有自报版本可比 |

应用的判断取其中最差的一个。宿主机上有、但没有任何清单提到的容器，列为"未纳入清单"。比如迁移前 Dossier 的旧服务 `proxy`，清单里已经改名为 `dossier-proxy`。非容器组件（Workbench 应用包、Agent 等）阶段 5 起才显示状态。

### 本地验证（2026-10-30）

- 26 个测试：注册表、格式校验、版本区间、认人与授权、CSRF、Workbench 宕机的宽限期、紧急账号、限流、状态判断。
- 用假 Workbench 加一份模拟的容器列表在浏览器里走了一遍，覆盖：
  - 未登录页；
  - 管理员看状态（Dossier 的 gotenberg 退出 → 异常，`dossier-proxy` 没有容器，旧 `proxy` 未纳入清单，Workbench 自报 1.24.0 而期望 1.23.1 → 版本不符）；
  - 注册表详情，新存一份从 0.8.0 起适用的清单；
  - 停掉 Workbench 后出现宽限期提示，清掉会话后用紧急账号登录。

## 阶段 2：执行器、构建与部署

### 分工（§8.2，D29）

- **Deployer**（容器，没有 Docker socket，没有镜像仓库凭据）：负责计划、权限、记录、页面。它生成一个应用的 compose 片段和根文件，写成请求交给执行器。
- **执行器**（[executor/deployer_executor.py](executor/deployer_executor.py)，宿主机 systemd 服务，root，只用 Python 3.9 标准库）：只做固定的几种任务：构建、部署，以及阶段 3 加的写 env、读 env；请求里从来不带命令。

两边的交接协议原来是共享目录（协议 1），2026-10-31 起改为执行器经 HTTPS 调 Deployer（协议 2，D35），见下面"多台服务器"一节。心跳超过 30 秒或协议不符，页面显示那台机器的执行器离线，放在那台机器上的应用不能构建和部署。执行器在执行任务期间也每 10 秒发一次心跳，`busy` 是正在执行的任务。

### 构建（§5.2）

只对清单里 `company-registry` 且带 `build` 的组件。按 Studio、Workbench、Dossier 现在的发布方式：

1. 干净 clone 应用的 tag。
2. 读这个 tag 的 `tools.lock`，取 open-atlas-release 对应的 `release-tools-<版本>`。
3. 运行它的 `build-images.sh <app> --source <checkout> --platform … --registry <登记的前缀> --push`。
4. 核对 `BUILD.json`：版本等于 tag、commit 等于 HEAD、`dirty: false`。记下推送后的 digest。

`build.script` 只接受 `build-images.sh`，镜像名必须是它产出的 `open-atlas-<app>`，仓库必须在执行器配置的 `EXECUTOR_REGISTRIES` 里。PROD 不构建（§6.1）。构建需要 `deploy-uat` 组。

### 部署（§8.1、§8.3）

页面上的流程是：选版本（列出 release 仓库里符合 tag 格式的 tag）→ 生成计划 → 确认 → 看进度和日志。

**计划会拒绝的情况**：
- 没有权限（UAT 要 `deploy-uat`，PROD 要 `deploy-prod`）；
- 没有覆盖这个版本的清单；
- 有阶段 5 才支持的组件（Workbench 应用包、Agent、迁移、Graph、bundle）；
- 自建镜像还没构建成功；
- 执行器离线；
- 这个应用已经有任务在进行；
- 服务名或端口冲突。

**人工步骤**：阶段 5 起不再在部署前确认，而是部署到那一步时暂停，逐项勾选后继续（见"阶段 5"）。`when: install` 的只在第一次部署时出现。

计划里还有每个服务"现在 → 部署后"的镜像，以及片段的逐行差异。

**执行器部署时依次做**：

1. **取发布文件**：清单 `volumes.file` 引用的文件从 release tag 取出，先放在旁边，不动现有的。
2. **拉取镜像并固定 digest**：片段里的 `image` 改写成 `仓库:tag@sha256:…`。自建镜像再核对一次镜像里的 `BUILD.json`。
3. **校验**：用新片段跑 `docker compose config`。以下任一情况都拒绝，而且什么都不改：
   - env 文件缺失；
   - 有 `${KEY}` 没设；
   - 违反策略：`privileged`、`cap_add`、`devices`、宿主机网络或 pid 等命名空间、`unconfined`、`build`、挂载 Docker socket、在应用目录和 `EXECUTOR_BIND_ROOTS` 之外的 bind 挂载、不在登记仓库里的镜像或 `latest` 公共镜像；
   - 宿主机端口被本应用之外的容器占用。比如 Dossier 迁移时旧的 `proxy` 占着 18100，要先手工停掉。
4. **备份**：暂停容器，打包数据目录（不含 `logs/`），每个应用保留 3 份。宿主机配了 `EXECUTOR_DB_DUMP_<APP>` 的，再导出数据库，导出失败就不部署（Dossier 的库在清单之外，沿用旧升级器的做法）。
5. **切换**：留下上一版的片段、根文件和 `files/`；第一次接管时，旧的手写根文件另存为 `compose.yaml.before-deployer`。缺失的数据目录按镜像的 `USER` 设属主。
6. **启动并验证**：只 `up` 这个应用的服务，不加 `--remove-orphans`，所以别的应用和还没迁移的旧容器不受影响。等每个服务都 running，有健康检查的要 healthy；默认等 300 秒，重启超过 3 次直接判失败。
7. **失败自动回滚**：先存下容器日志。
   - 换回上一版的片段和文件，重新启动；
   - 上一版也起不来，就把数据目录改名留着，从备份恢复（有 `EXECUTOR_DB_RESTORE_<APP>` 的也恢复数据库），再启动。

   结果是"已回滚"或"失败，需要人处理"。如果这是第一次经 Deployer 部署就失败，新容器会被移除。
8. **成功后**：移除这个应用里已经不在清单中的服务（按 `org.open-atlas.app` 标签）。Deployer 再问一次 `/meta/contracts`，把观察到的版本写进部署记录。

### 期望状态、部署记录、回到旧版

- 每个应用的版本取自最近一次**成功**的部署；还没经 Deployer 部署过的，用 `environment.json` 里的版本。回滚了的部署不改变版本。
- 根文件只 include 已经由 Deployer 部署过的应用，加上这次部署的应用，所以迁移可以一个应用一个应用来。
- 每个部署任务带一份按 OMA `deployment-receipt:1` 取字段的记录（§8.5）。`config_revision` 是部署时服务器上的 env 版本（如 `dossier.env#7`），Deployer 还没接管 env 文件时为 null。
- "部署记录"里任何一次成功的部署都可以"回到这一版"：请求里带上那次的 digest，拉取的是原样的镜像。用的清单是这个区间**当前**的那一版。
- 构建、部署的请求和结果都记审计。

### Deployer 镜像与服务器上的安装（2026-11-02）

正式的镜像和发布包由 GitHub Actions 在推送 tag `v<版本>` 时生成（[.github/workflows/release.yml](.github/workflows/release.yml)），步骤和**第一次发布的注意事项**见 [docs/release.md](docs/release.md)，每个版本的说明在 [CHANGELOG.md](CHANGELOG.md)。本地试验时可以手工构建：

```sh
bin/build-image.sh [镜像仓库]       # 默认 ghcr.io/godfengz；同时把执行器的发布包打到 dist/executor
docker push <镜像仓库>/open-atlas-deployer:<package.json 的版本>
```

- [Dockerfile](Dockerfile)：Node 22 直接运行服务端的 TypeScript，用自带的 `node:sqlite`；页面在构建时按 `DEPLOYER_BASE_PATH`（默认 `/deploy`）打包，一个镜像对应一个挂载路径。以 1000:1000 运行，不挂 Docker socket、没有镜像仓库凭据；健康检查访问 `/health`。镜像带 `org.open-atlas.version` 和提交号标签。工作区有未提交改动时，构建脚本会提示镜像对不上提交号。
- 服务器上的布局见 [examples/deployer/compose.yaml](examples/deployer/compose.yaml) 和 [deployer.env.example](examples/deployer/deployer.env.example)：放在 `/webapp/data/open-atlas/deployer/`（执行器的部署根目录跳过这个目录），自成一个 compose 项目 `open-atlas-deployer`，执行器对应用做的 compose up、回滚、恢复都碰不到它；端口只绑 127.0.0.1:8095，由 nginx 经 https 转发；加入应用的网络 `open-atlas_default`，按服务名访问 Workbench 和各服务的 `/meta/contracts`。`data/` 和 `secrets/` 要属 1000:1000，令牌和 key 文件权限 600。
- 第一个候选版本是 `0.1.0-rc.1`（之前的 `0.1.0-beta.*` 只在本地构建过）。compose 里的镜像写成 `${DEPLOYER_IMAGE}`，值在同目录的 `.env`（[.env.example](examples/deployer/.env.example)）：第一次手写，之后由执行器改。

Deployer 自己的升级（D16，2026-11-02 已实现）：admin 在 Overview 的 Platform 区选版本、看过计划后确认（D39，原先在 Hosts 页，已移走）。Deployer 找到心跳里说自己运行 Deployer 的那台机器（`executor.env` 设了 `EXECUTOR_DEPLOYER_DIR` 和 `EXECUTOR_DEPLOYER_IMAGE`，只能有一台），排一个 `deployer-upgrade` 任务，请求里只有版本号。执行器：

1. 拉 `<EXECUTOR_DEPLOYER_IMAGE>:<版本>`（仓库必须在 `EXECUTOR_REGISTRIES` 里），固定 digest；镜像标签 `org.open-atlas.version` 要等于这个版本，`org.open-atlas.executor-protocols` 要包含本执行器的协议，否则拒绝，什么都不动。
2. `docker compose stop` 停掉 Deployer，打包 `data/` 到 `<备份目录>/deployer/`（保留 3 份）。
3. 把 `.env` 里的 `DEPLOYER_IMAGE` 换成固定 digest 的新镜像（旧的存为 `.env.previous`），`docker compose up -d`。
4. 等容器 healthy，并且新 Deployer 对心跳的应答里自报的版本就是新版本（心跳应答现在带 `deployer` 版本）。
5. 不行就换回 `.env.previous`，把新版本留下的 `data/` 改名为 `data.failed-<时间>`，从备份恢复 `data/`，再启动旧版本：成功记"已回滚"，旧版本也起不来记"失败，需要人处理"。

升级期间 Deployer 不在，执行器回报不出去的状态和日志先存在本地 `<工作目录>/pending/`，等 Deployer 回来再补发；回滚时恢复的是升级前的状态库，这个任务在里面还是"进行中"，由补发的结果收尾。还在跑别的任务、执行器太旧（0.7.0 以前）、找不到或找到多台运行 Deployer 的机器时拦住。允许换到更旧的版本（坏版本要退回时用），只限 admin 的浏览器会话。Deployer 的版本取镜像构建时的 `DEPLOYER_VERSION`，从源码运行时取 `package.json`。

- 第一次安装后，在运行 Deployer 的机器的 `executor.env` 里设 `EXECUTOR_DEPLOYER_DIR=/webapp/data/open-atlas/deployer`、`EXECUTOR_DEPLOYER_IMAGE=ghcr.io/godfengz/open-atlas-deployer`，重启执行器。紧急时仍可手工：改 `.env` 后 `docker compose up -d`。
- `deployer.env` 由 compose 读入，值里的 `$` 会被当成变量替换掉；紧急账号的哈希因此改成 `scrypt:<盐>:<值>`（2026-11-02，旧的 `$` 格式仍能验证，但放进 compose 前要换成冒号）。
- 验证（WSL）：镜像构建成功（339 MB）；用它替换本地的 Node 进程（host 网络，同一份设置和状态库）后健康检查通过，经 nginx 的 https 页面和静态资源 200，未登录时正确指向 Workbench，执行器的心跳由容器里的 Deployer 写入；没挂 Docker socket，进程是 1000:1000。验证完已换回 Node 进程。

### 执行器安装（§8.6）

```sh
sudo ./executor/install.sh          # /opt/open-atlas-deployer/executor/releases/<版本>，current 软链接，systemd 服务
sudoedit /etc/open-atlas-deployer/executor.env   # 见 executor/executor.env.example（EXECUTOR_DEPLOYER_URL、EXECUTOR_TOKEN_FILE）
# 这台机器的执行器凭据：在 Deployer 的 Hosts 页签发（只显示一次），存进 EXECUTOR_TOKEN_FILE（600）。
# 第一次安装、还没法登录页面时，在 Deployer 所在机器上：node bin/executor-token.ts <DEPLOYER_DATA> <机器名> <文件>
sudo docker login ghcr.io           # 推送与拉取凭据只在宿主机 root 下
sudo systemctl restart open-atlas-deployer-executor
python3 /opt/open-atlas-deployer/executor/current/deployer_executor.py check
```

[executor/launch.sh](executor/launch.sh) 负责启动计数：有 `upgrade-pending` 标记时连续 3 次自检不过，就退回旧版本。[executor/switch](executor/switch) 用来手工切换版本。

执行器的升级（2026-11-01 已实现，§8.6）：admin 在 Overview 的 Platform 区对版本低于 Deployer 自带版本（`EXECUTOR_VERSION`，与 `executor/deployer_executor.py` 的 `VERSION` 一致，测试核对）的机器点"Upgrade"，或用"Upgrade outdated"一台一台地升（D39），Deployer 排一个 `executor-upgrade` 任务，请求里只有版本号。执行器只从本机 `executor.env` 的 `EXECUTOR_UPGRADE_FROM` 取发布包：GitHub 仓库 `owner/name` 的 release `executor-v<版本>`，或一个绝对路径目录下的 `executor-v<版本>/`；包是 `executor/package.sh` 打出的 `open-atlas-deployer-executor-<版本>.tar.gz` 和 `SHA256SUMS`。执行器核对哈希、只接受一层目录里那几个已知文件、代码里的版本号要对得上且能编译，装到 `releases/<版本>`，写 `upgrade-pending`，切 `current`，退出；systemd 经 `launch.sh` 拉起新版本，自检通过后由新版本回报成功并只保留当前、上一版和最新 3 个版本目录；连续 3 次起不来，`launch.sh` 退回旧版本，由旧版本回报失败。不接受降级（回旧版用 `switch`）；`launch.sh` 本身不随升级替换，变了会在结果里提示重跑 `install.sh`。只限 admin 的浏览器会话；机器离线、还在跑任务、执行器太旧（0.6.0 以前，要手工装一次）、没配 `EXECUTOR_UPGRADE_FROM` 时拦住并说明原因。

第一次安装：在一台能连 GitHub 的机器上 `executor/package.sh <输出目录>`，把包和 `SHA256SUMS` 挂到 release `executor-v<版本>`（或放进内网目录），服务器上解压后 `sudo ./install.sh`。正式发布后，发布流程会自动建好 `executor-v<版本>`，直接从那里下载即可。

### 测试与验证（2026-10-30）

- `npm test`：31 个测试。阶段 2 新增：计划的拒绝项、构建与部署请求的内容、部署记录、回滚后的期望版本、按 digest 回到旧版、PROD 不构建。
- `python3 -m unittest executor/test_deployer_executor.py`：12 个测试。覆盖镜像来源规则、策略、端口占用、Compose 5 的缺变量警告格式、请求校验、心跳、中断任务的恢复。
- **WSL 端到端**（Docker 29.9.2，Compose 5.6.1，本地镜像仓库）：用 busybox 做了一个三个版本的测试应用，真实跑了以下几种情况：
  - 缺 env 文件 → 拒绝；
  - 缺变量 → 拒绝；
  - 部署 1.0.0 → 成功，镜像按 digest 固定，env 生效，数据目录可写；
  - 启动即崩的 1.1.0 → 40 秒内自动回滚，页面仍是 v1；
  - 部署 1.2.0 → 成功；
  - 按 digest 回到 1.0.0 → 成功；
  - 端口被外部容器占用 → 拒绝；
  - `compose` 附加字段加了 `privileged` 和挂载 `/etc` → 被策略拒绝。

  每次部署前都做了数据备份，所有拒绝都没有改动运行中的应用。页面上走通了生成计划、看片段差异、确认部署、看进度和日志、部署记录。

  端到端过程中修了两个问题：交接目录不存在时执行器自检会失败；Compose 5 的缺变量警告格式没被认出来，导致缺变量没被拒绝。
- **没有端到端验证的**：
  - **真实构建**：需要 GitHub 令牌和 GHCR 推送权限，只做了单元测试里的拒绝项；
  - **"上一版也起不来 → 从备份恢复数据和数据库"这一支**；
  - **以 root 运行时数据目录的属主设置**：本地以普通用户运行，跳过了 chown。

## 阶段 3：环境变量（§7.2）

每个应用一个 env 文件（清单的 `env.file`，在部署根目录下），Deployer 是它唯一的维护者。页面上"环境变量"一页。

### 接管：先从服务器导入

第一次先点"从服务器导入"：执行器读出服务器上现有的文件，Deployer 存成第 1 版，并记为"服务器上的版本"。没导入之前不能写入，免得盲目覆盖。服务器上没有这个文件也算导入，记为空的一版。

### 保存：每次修改是一个版本

- 保存不会动服务器，只是多一个版本，记下谁、何时、改了哪些键。密钥只记"已修改"，审计里也一样。
- 清单 `env.secrets` 列出的键，加上名字像密钥的键（以 `PASSWORD`、`SECRET`、`TOKEN`、`_KEY` 等结尾），都用 AES-256-GCM 加密保存。页面上遮盖显示，只有 Workbench 管理员能点"查看原值"，每次查看都记审计。
- 编辑时页面拿不到密钥原值：留空表示不修改，提交为 `keep`。
- 保存时带上基于哪一版。别人先保存了，就返回 409，请刷新后再改。
- "回到这一版"：用旧版本的值另存为新版本，再走写入。

### 校验

- 对照应用 release tag 里的 `.env.example`（清单 `env.schema`，经 GitHub contents API 读取），或 Deployer 自己的模板（`env.template`）：不带 `#` 的 `KEY=` 是应设置的键，带 `#` 的 `#KEY=` 是已知的可选键。
- 列出：缺少的键、多出来的键、可能改了名的键（编辑距离近，或末尾两段相同）。这些只提示，不阻止。
- compose 片段里用到的 `${KEY}`（不带默认值的）没设置，会**阻止**写入，也会阻止部署。

### 写入：先看计划

- 计划列出改了哪些键、会重启哪些服务：`envFile: true` 的服务，加上 `environment` 里引用了改动键的服务。
- 执行器：先把旧文件另存为 `<app>/.deployer/env.previous`，再以 0600 原子写入新文件。然后用 `compose config` 校验，缺变量就换回旧文件并拒绝。接着 `compose up -d`，只有配置变了的容器会重建；最后等健康检查。起不来就换回旧文件再起一次，任务状态记为"已回滚"。
- 还没经 Deployer 部署过的应用：只写文件，不重启。
- env 内容只在请求文件里出现（0600）。执行器领取后立刻从 `request.json` 里删掉，只留 sha256；Deployer 的任务记录里也只有哈希；日志不记录取值。
- 部署计划会检查服务器上的 env：片段要用的 `${KEY}` 缺了就阻止部署；有还没写入的修改会提示。

### UAT 与 PROD 对比

"与另一环境对比"会给出本环境的指纹：非密钥给值，密钥给 HMAC（用 `DEPLOYER_COMPARE_KEY` 计算）。把它复制到另一个环境的 Deployer 页面里粘贴，就能逐键看相同还是不同。两个 Deployer 之间自动获取等阶段 4（§6.3）。

### 接口

`GET /api/apps/:id/env`（`?revision=`）、`PUT /api/apps/:id/env`、`POST …/env/revert`、`…/env/reveal`（仅管理员）、`…/env/plan`、`…/env/apply`、`…/env/import`、`GET …/env/fingerprint`。看需要 view，改、导入、写入需要本环境的部署权限。

### 测试与验证（2026-10-30）

- `npm test`：43 个测试。阶段 3 新增 env 文件的读写（包括引号、转义、多行）、`.env.example` 解析、校验与改名提示、受影响的服务、加密与防篡改；HTTP 流程覆盖导入、遮盖与查看原值、版本与冲突、回到旧版、计划与写入、部署前检查、部署记录的 `config_revision`、指纹。
- `python3 -m unittest executor/test_deployer_executor.py`：16 个测试。新增哈希校验、领取后抹掉内容、只写不重启、读 env 并到期删除。
- **WSL 端到端**（同阶段 2 的环境，加一个 `GREETING=crash` 就起不来的版本）：
  - 手写的 env 部署（提示未接管）→ 导入；
  - 改成带空格、`$`、单引号、`#` 的值 → 写入；容器里拿到的值和输入完全一致，文件权限 0600，请求、日志、状态库里都找不到密钥原文；
  - 去掉片段要用的键 → 计划阻止；
  - `GREETING=crash` → 服务起不来，自动换回旧文件，状态"已回滚"；
  - 回到第 2 版 → 写入；只改密钥 → 历史里记"已修改"；
  - 再部署 → 记录里 `config_revision` 为 `hello.env#6`；指纹、查看原值、审计都正常。

  端到端时修了一个问题：值没变时，计划仍然列出要重启的服务。

## 阶段 4：制品与晋级（§6）

### 制品（§6.1）

页面上"制品"一页：每个镜像按 `应用 + 服务 + digest` 记一条，记下来源（本环境构建、按 tag 拉取、取自 UAT 的 digest、按 digest 回到旧版）、`BUILD.json`、首次出现的任务，以及本环境每次用到它的部署和结果。构建成功、部署结束（成功、失败、回滚都算，只要拉到了 digest）时自动记录。

### 晋级规则（§6.2）

环境名是 `prod` 时，每个部署计划先判断能不能晋级，按顺序：

1. **回到本环境部署成功过的那一版**（`pinFrom`）：那些 digest 当时已经满足规则。
2. **UAT 部署成功过**：向 UAT 的 Deployer 查这个版本最近一次成功的部署，**按它的 digest 部署**，所以 PROD 跑的就是 UAT 验证过的镜像，PROD 不构建。要观察期的应用，在 PROD 的 `environment.json` 里给它设 `uatSoakHours`；运行时间算到 UAT 用下一次成功部署替换它为止。
3. **已正式发布**：自己的镜像要求 release tag 有 GitHub Release，而且不是草稿或预发布；只用公共镜像的，要求都钉了版本号（不能是 `latest`）。这时按 tag 拉取。
4. 都不满足：`deploy/not-promoted` 阻止部署，原因写明（UAT 没跑过、运行时间不够、连不上 UAT、没有 Release）。**Workbench 管理员**可以填写原因跳过：计划上标"管理员跳过"，审计记 `deploy.promotion-override`（原因和没满足的条件）。

晋级依据写进部署请求，任务详情和制品页上都能看到。

### 两个 Deployer 之间（§6.3）

- UAT 开放只读的 `/api/peer/*`，只认只读 key（`Authorization: Bearer dpr_…`），Workbench 会话不行：
  - `status`：每个应用最近一次成功部署的版本和 digest；
  - `apps/:id/deployments?version=`：成功部署的记录（何时部署、何时被替换、env 版本）；
  - `apps/:id/env/fingerprint`：env 指纹。
- PROD：状态页多一列"UAT 现在"，版本不同时标"可晋级"；连不上 UAT 时页面顶部提示，只有已发布的版本或管理员跳过才能部署。环境变量对比自动取 UAT 的指纹，不用再复制粘贴（取不到时仍可粘贴）。
- PROD 对 UAT 的请求缓存 30 秒，超时 5 秒。

### 测试与验证（2026-10-30）

- `npm test`：49 个测试。阶段 4 新增：制品记录与部署去向、peer API 只认只读 key、PROD 按 UAT 的 digest 部署、不满足规则时拒绝、Release 放行、管理员跳过要有原因并记审计、连不上 UAT 的提示、观察期、经 peer API 对比 env。测试里 UAT 和 PROD 是两个真实的应用实例，PROD 的请求直接打到 UAT 实例上。
- **WSL 端到端**：同一台 Docker 上起 UAT、PROD 两个 Deployer，各自一个执行器、一个 compose 项目，共用本地镜像仓库：
  - UAT 部署 1.3.0 → PROD 计划按 UAT 的记录晋级 → 部署后两边容器的镜像 digest 完全相同；
  - PROD 部署 UAT 没跑过的 1.2.0 → 被拒绝；管理员填写原因后部署成功，审计里有原因；
  - 回到 PROD 的 1.3.0 部署 → 依据为"本环境部署成功过"；
  - 制品页显示两个 digest 的来源和晋级依据；状态页显示 UAT 版本；env 指纹经 peer API 取到；
  - 停掉 UAT 的 Deployer → PROD 计划写明"无法确认 UAT 记录"，状态页顶部提示。

### 还没做

- **契约核对（§6.4）**：用制品的 provides / requires 对照其他应用的实际版本。阶段表里没有排它；Logbook 这类有 requires 的应用要到阶段 5 才能由 Deployer 部署，建议在阶段 5 一起做。
- **接入评估登记的外部仓库第一次上 PROD 必须先过 UAT**（§6.2 例外）：要等阶段 7 有了接入评估才有这类仓库。
- **真实 GitHub Release 查询**：只在测试里用了假的回答；端到端里的测试仓库不存在，所以总是"没有 Release"。

## 阶段 5：一个应用的全部组件一次部署（§4.2）

### 部署按 `dependsOn` 的顺序走

计划列出每个组件一步：谁来做（执行器 / Deployer / 人）、现在 → 部署后、对用户的影响。执行时：

1. **执行器的部分先做**（`compose-service`、`db-migration`，一个执行器任务）：和阶段 2 一样拉取、校验、备份、切换；有迁移时先只启动数据库，执行迁移，再启动其余服务，等健康检查。失败照旧自动回滚。
2. **然后 Deployer 依次调用各服务**：`studio-graph` → Studio Builder MCP，`workbench-app` → Workbench Administration API，`oma-agent` → OMA Builder MCP + Workbench。每一步 apply 之后核对一次。
3. **`manual` 处暂停**：页面上逐项勾选（记下谁、何时，记审计），全部勾选后继续；也可以在这一步停止部署。`when: install` 的只在第一次部署时出现。

某个 Deployer 步骤失败时，按相反顺序撤回它之前的 Deployer 步骤（Workbench 切回上一版、Business Agent 指回原来的 agent）；做不到撤回的（Studio 图已经发布）写明"未撤回"。容器已经通过健康检查，保持新版本，任务记为失败，需要时在部署记录里回到上一版。宿主机的组件不能依赖 Deployer 或人工的组件（计划拒绝 `deploy/order`）。没有容器的应用不需要执行器。

### Release 附件（bundle，§5.1）

清单有 `bundle` 时，Deployer 下载 Release 附件（存在数据目录 `bundles/` 下，只下载一次），按包里的 `SHA256SUMS` 核对（`SHA256SUMS` 列出自己的那一行跳过），整个包的 sha256 就是它的 digest：记进部署记录（`artifact_digest.bundle`）和制品页，PROD 晋级时要与 UAT 那次部署的一致（`deploy/bundle-changed`）。执行器要挂载的文件和迁移脚本也从这个包里取：执行器自己下载，核对与计划时的 sha256 相同，只解出普通文件（链接、`..` 一律拒绝）。

### 各驱动

| 驱动 | 做什么 | 这个环境要配的 |
|---|---|---|
| `workbench-app` | bundle 就是业务包：核对 `app/app.json` 的版本，上传安装（slot 按名字绑定），写 `settings`（`${KEY}` 取自 env 文件）；撤回 = `switch-version` | `DEPLOYER_WORKBENCH_API_KEY_FILE` |
| `studio-graph` | 取图的草稿 → 上传 Deployer 保存的 EDN（清单字段 `contract`，`templates/` 下）→ 存 `savedQueries` → `publish_graph apply:true`。EDN 里自己的 workspace id、graph id（`:ownership` 里也有）全部换成目标图的 | `settings.<组件>.graph`（Studio 里的图名）；图和它的 Source 每个环境先由人建好 |
| `oma-agent` | 用 Deployer 保存的 Agent 包定义（清单字段 `package`，`templates/` 下的 JSON，`{{system}}` 是 bundle 里的提示词，其余 `{{…}}` 取这个环境的 settings）发布新修订，把绑定在应用 slot 上的 Business Agent 指向新 agent；包 id 和 agent id 记在 Deployer 里 | `settings.<组件>`：`model`、图的 MCP 地址等 |
| `db-migration` | 执行器在数据库容器里用 psql 执行：`install` 只在空库执行一次，`migrations` 按文件名顺序执行还没执行过的；每个脚本和它在 `deployer.migrations` 的记录在同一个事务里 | 无 |
| `manual` | 人逐项勾选 | 无 |

这个环境的组件设置写在 `environment.json` 的 `apps.<应用>.settings.<组件 id>` 里（例子见 [examples/uat.environment.json](examples/uat.environment.json)）。Logbook 用的模板：[templates/logbook.graph.edn](templates/logbook.graph.edn)（由 Logbook 的 `graph/gen_graph.py` 生成，id 已换成占位）、[templates/logbook-assistant.oma.json](templates/logbook-assistant.oma.json)（来自 Logbook 的 `agents/publish-oma.py`）；带这两个字段的 Logbook 清单在 [examples/logbook.manifest.json](examples/logbook.manifest.json)。清单格式新增的两个可选字段（`studio-graph.contract`、`oma-agent.package`）已加进 [schema/](schema/deploy-manifest-v1.schema.json)。

### 契约核对（§6.4）

计划时读这个版本 tag 上的 `release.json` / `package.json`，与这个环境里其他应用的版本（最近一次部署的，或 `environment.json` 里的）各自的 `provides` / `requires` 对照，两个方向都查：这个版本要求的有人提供，别的应用要求的这个版本仍然满足。不满足时拒绝（`deploy/contract`），写明哪两个应用、哪条契约；读不到、或没有登记提供者时只提示。支持 `^1.3`、`~1.3`、`>=1.2`、`1.5`、`1`、`*`。

### 测试与验证（2026-10-30）

- `npm test`：59 个（新增：解包与 SHA256SUMS、契约范围与双向核对、执行顺序、占位符；Logbook 形状的应用对着假的 GitHub / Workbench / Studio / OMA：计划的各步、执行器请求、Deployer 各步、人工步骤、制品、失败撤回、缺配置的提示）。执行器 20 个（新增：从 bundle 取文件、拒绝链接、迁移只执行一次且带记录、拒绝越界的迁移）。
- **WSL 端到端：Logbook 0.7.8 一次部署**。发布包用 Logbook 仓库的文件按 Release 包的布局打成（另加一条测试迁移），PostgreSQL 和 PostgREST 是真的容器，GitHub、Workbench、Studio、OMA 是替身：
  - 计划 7 步：db、迁移、api（执行器）→ 图、应用包、助手（Deployer）→ 首次安装（人）；
  - PostgreSQL 按 Logbook 的 `pkg/db` 初始化（35 张表），迁移执行并记录，PostgREST 起来；Studio 收到换好 id 的 EDN 和 15 条 saved queries 并发布；Workbench 装上 0.7.8，slot 绑定到 "Logbook Assistant"；OMA 发布新 agent，Business Agent 指向它；停在首次安装，勾选两项后成功，部署记录带 bundle 的 digest；
  - 再部署一次：迁移不再执行，OMA 新修订，Business Agent 指向新 agent；
  - OMA 发布失败：Workbench 切回、Business Agent 不变，Studio 写明未撤回；
  - Workbench 版本太旧（提供 `workbench-app 1.2`）：计划拒绝，写明 `logbook 0.7.8 要求 workbench-app ^1.3`。
  - 端到端发现并修了：`SHA256SUMS` 列出自己时核对失败；Studio 没撤回却显示"已撤回"。另外发现 Windows 检出的 Logbook 文件是 CRLF，`10-roles.sh` 在 bash 下出错：Release 包必须用 LF 的文件打（端到端里先转换）。

### 还没做

- 真实的 Workbench、Studio、OMA 都只用替身验证过；Logbook 的 GitHub Release 附件（`logbook-0.7.8.tar.gz`）是否存在、布局是否和这里一致，要在真实环境确认。
- 首次安装里人做的部分照旧是人做：建 Studio 图和 Source、令牌、Business Agent、插件条目、数据导入。
- Studio 图的撤回（发布回旧版本）。
- 新版本时由 AI 在沙箱里重新生成 EDN（阶段 6 / 7）。

## 阶段 6：AI 接入（§9.4、§10）

### API key（§9.4）

页面上"API key"一页：

- **个人 key**（`dpk_`）：本人用 Workbench 登录生成，绑定本人；只显示一次，只存 SHA-256；有效期 1–365 天。每次调用都用 Workbench API key 向 Workbench 重新确认主人仍然启用、在哪些组，所以停用或移出组下一次调用就生效。能做的和主人在页面上一样，但 **PROD 的部署、写环境变量、勾选人工步骤，跳过晋级，查看密钥原值**只认浏览器会话（`auth/browser-only`）。
- **服务 key**（`dps_`）：管理员生成，给 OMA Vault 里的 Deploy Assistant 用，只读，没有人在它背后。
- 不能用 key 生成或吊销 key。生成、吊销都记审计。

要启用 key，需要 `DEPLOYER_WORKBENCH_API_KEY_FILE`（向 Workbench 确认主人）。

### `/mcp`

`POST <base path>/mcp`，JSON-RPC（MCP streamable HTTP，只回 JSON），`Authorization: Bearer dpk_…` 或 `dps_…`。

- 每个工具就是页面上的一个查询或命令，在进程内以 key 的身份调同一个接口，所以权限、校验、审计和页面完全一样；被拒绝时返回那个接口自己的 finding（`code / at / expected`）。
- 只读工具：`get_status`、`list_apps`、`get_app`、`list_versions`、`plan_deploy`、`list_jobs`、`get_job`、`list_artifacts`、`get_env`、`plan_env`、`get_env_fingerprint`、`compare_env_with_uat`。服务 key 只看得到这些。
- 命令：`deploy`、`build`、`set_env_values`、`apply_env`、`import_env`、`check_manual_item`、`stop_deploy`。必须带 `request_id`：同一个 `request_id` 重发，得到第一次的结果，不会做两次。
- 没声明的参数按名字拒绝；每次调用记审计 `mcp.<工具>`。

Claude Code 里用：

```bash
claude mcp add --transport http open-atlas-deployer https://<域名>/deploy/mcp --header "Authorization: Bearer dpk_…"
```

### 页面旁的 Deploy Assistant（接法 A）

顶栏"问助手"打开右侧面板，嵌入 Workbench 的 `/embed/chat?app=deployer`。页面把当前环境、页面、应用作为上下文发给它。Agent 只读；它在回复里出的 ` ```app-actions ` 卡片，人点"应用"后，由页面以本人身份执行，只接受这四种操作，只接受 Workbench 源发来的消息：

| 操作 | 页面做什么 |
|---|---|
| `plan_deploy` | 打开这个版本的部署计划，人还要在计划上确认部署 |
| `plan_rollback` | 打开回到某次部署（`pin_from`）的计划 |
| `build_artifact` | 开始构建 |
| `set_env_value` | 保存一个新的环境变量版本（不写入服务器，写入要在环境变量页看计划后做） |

在 Workbench 里登记的应用条目见 [examples/workbench-application.deployer.json](examples/workbench-application.deployer.json)（`put_plugin`），Business Agent 名为 "Deploy Assistant"。

### Deploy Assistant 的发布

- 提示词 [agents/deploy-assistant.md](agents/deploy-assistant.md)，包定义 [templates/deploy-assistant.oma.json](templates/deploy-assistant.oma.json)（只开 Deployer 的 MCP，`allowed_tools` 只列只读工具，沙箱工具关闭，表格渲染器），随 Deployer 一起发版。
- 发布：

```bash
node bin/publish-assistant.ts <OMA Builder MCP 地址> <builder key 文件> <模型名> https://<域名>/deploy/mcp ./assistant-uat.json
```

  打印新的 agent id；把 Workbench 的 Business Agent "Deploy Assistant" 指向它，并设为 `DEPLOYER_OMA_AGENT`。OMA Vault 里按 MCP 地址存服务 key。
- 用例：[docs/golden-cases.md](docs/golden-cases.md)（读、卡片、越权）。

### 部署失败后的自动诊断（接法 B，D24）

部署失败或回滚后，Deployer 用自己的 OMA Application 开一个 Session，把任务的状态、各步、执行器日志的最后 150 行、Deployer 步骤日志交给 Deploy Assistant，要求只读地判断原因，最后回一个 JSON（原因、日志原文依据、建议、把握）。结果存在任务上，任务详情和部署记录（`diagnosis`）里能看到；10 分钟没结果记为失败。没配 OMA 时不诊断，部署照常。

### 测试与验证（2026-10-30）

- `npm test`：63 个。阶段 6 新增：个人 key 跟着 Workbench 的启用和组走、key 不能生成 key、吊销；`/mcp` 的工具列表、服务 key 只读、未声明参数被拒、拒绝带原接口的 finding、`request_id` 重发不重复部署、审计；PROD 执行 / 跳过晋级 / 查看密钥原值拒绝 key；失败诊断开 Session 的参数、提示词里的日志、读回答写进部署记录。
- 页面（API key 页、助手面板）已构建，没有在浏览器里对着真实的 Workbench 嵌入页试过。

### 还没做

- 真实 OMA、Workbench 上的发布与验证（O1–O4、Business Agent、Role、嵌入页、golden cases）。
- 新版本的清单评估（D27）放到阶段 7，和接入评估共用任务令牌与草案工作区。

## 阶段 7：接入评估与版本评估（§10.5，D27）

页面上"接入评估"一页（`deploy-uat` 的人发起，只在 UAT）。

### 流程

1. **扫描**（程序）：GitHub 的 tags 和 Release、这个环境已占用的端口 / 服务名 / 数据目录。不受信任的仓库不进 Deployer 的进程。
2. **评估**（Onboarding Assessor，OMA 的隔离 Environment）：Deployer 开 Session，第一条消息带仓库、扫描结果、评估 id 和**任务令牌**（只对这一次评估的草案有效，24 小时）。Agent 在沙箱里克隆只读，定级 A / B / C / D。页面显示进度。
3. **配置草案**：草案是一份不生效的清单加 env 键。Agent 用 `/mcp` 的 `draft_*` 工具改（服务 key + 任务令牌，每次带 `reason`），人在页面上也能接着改（整份 JSON 加原因）。每次修改记下谁、改了什么、为什么。草案不允许特权、宿主机命名空间、`build` 等附加字段，密钥不能有默认值。
4. **校验**（程序）：schema、和已登记应用的冲突、compose 生成、数据目录、release tag 是否存在。
5. **试部署**（`deploy-uat` 的人）：A / B 级、校验通过后，把草案作为"试部署"应用加入注册表，写出 env 模板（数据目录 `templates/`），按正常流程在 UAT 部署。
6. **登记**（管理员）：试部署成功后去掉试部署标记。关闭评估时，试部署中的应用从注册表移除。

C 级（要改仓库）和 Deployer 缺能力时，Agent 起草 Issue；人在页面上确认后开到 **Deployer 自己的仓库**（`onboarding` / `capability` 标签），不往源仓库写任何东西。

### 新版本的清单评估（D27）

同一页"评估新版本"：选应用和新版本，Deployer 取两个 tag 之间部署相关文件（`.env.example`、Dockerfile、compose、`release.json` / `package.json` 等）的差异、提交标题和发布记录，草案从当前清单复制（`appliesFrom` 设为新版本）。Agent 判断"不用改"或改好草案；管理员确认沿用或采用新清单。

`environment.json` 里设 `"requireEvaluation": true` 时，比清单起始版本新、又没在这里部署过的版本，要有已采用的版本评估才能部署（`deploy/not-evaluated`）。默认不要求：OMA 不可用时不影响部署。

### Onboarding Assessor 的发布

提示词 [agents/onboarding-assessor.md](agents/onboarding-assessor.md)，包定义 [templates/onboarding-assessor.oma.json](templates/onboarding-assessor.oma.json)（开沙箱文件工具，`allowed_tools` 是只读工具加草案工具）：

```bash
node bin/publish-assistant.ts <OMA Builder MCP 地址> <builder key 文件> <模型名> https://<域名>/deploy/mcp ./assessor-uat.json onboarding-assessor
```

### 测试与验证（2026-10-31）

- `npm test`：66 个。阶段 7 新增：扫描事实、开 Session 用隔离 Environment、任务令牌（错的、别的评估的、评估结束后都拒绝）、Agent 和人交替改草案及修改记录、禁止字段与密钥默认值、校验、试部署进注册表并按正常流程部署、管理员登记；C 级 Issue 只能由人开到 Deployer 仓库；版本评估只列部署相关文件、沿用清单后放行 `requireEvaluation`。
- 真实 OMA 上的评估还没跑过。

### 还没做

- 外部仓库第一次上 PROD 必须先过 UAT（§6.2 例外）：评估和登记都在 UAT 的 Deployer，PROD 的注册表不知道一个应用是不是从评估来的；目前靠 PROD 照常的晋级规则（UAT 部署成功过，或已正式发布）。
- 镜像仓库里有哪些版本（§10.5.2 表里 Deployer 看的一项）还没查。
- 非 GitHub 仓库（Bitbucket）只给 Agent 地址，tags 和 Release 由 Agent 在沙箱里用 git 看。

## 阶段 8：维护提示、漂移、每日简报（§8.4、§7.1、D25）

### 部署前通知用户（W3）

部署计划里有要重启的容器时，可以选"N 分钟后部署，先在 Workbench 通知用户"（5 / 10 / 15 / 30 分钟）。Deployer 用 Workbench API key 设置维护提示（Workbench 1.25 的 W3：所有登录的人在顶部看到"<应用> 将在 HH:mm 更新到 <版本>，届时约 1–2 分钟不可用"），到时间才把任务交给执行器；部署结束（成功、失败、回滚）时撤下提示。还没开始时可以取消，提示同时撤下。需要 Workbench 1.25 和 `DEPLOYER_WORKBENCH_API_KEY_FILE`。

### 漂移（§7.1）

每 10 分钟（和打开首页时）比较一次，只提示、不改回：

- **版本**：经 Deployer 部署过的应用，容器跑的不是期望版本；
- **compose 片段**：服务器上 `<app>/compose.yaml` 的 SHA-256 不是 Deployer 最后一次部署时写入的（执行器 0.4.0 在部署结果里记 `fragmentSha256`）；
- **env 文件**：不是 Deployer 最后一次写入或导入的那份。

执行器每 30 秒在容器列表旁写 `files.json`：它管理的 compose 文件和 env 文件的 SHA-256，从不写内容。每处差异第一次出现、消失时各记一次审计（`drift.detected` / `drift.resolved`），首页顶部列出。

### 每日简报（D25）

每天 `DEPLOYER_BRIEF_HOUR` 点后生成一次，只显示在首页，不推送：各应用的新版本（读不到版本列表时写明"不知道"）、PROD 里 UAT 已跑过的版本、漂移、24 小时内失败的部署（带诊断）、停在人工步骤的部署。配了 OMA（`DEPLOYER_OMA_AGENT`）时由 Deploy Assistant 写成一段话，否则直接列出事实。部署组里的人可以重新生成。

### 测试与验证（2026-10-31）

- `npm test`：70 个。阶段 8 新增：预定部署到时间才交给执行器、结束时撤下提示、取消预定；三种漂移的发现、只审计一次、消失时记解决；简报到点生成、AI 写完、一天一次、没有 OMA 时只列事实；简报事实的来源。执行器 21 个（新增文件哈希）。
- 页面在浏览器里对着假 Workbench 看过：首页简报和重新生成、API key 生成、`/mcp` 用这把 key 列工具和调用、接入评估页、助手面板嵌入地址。
- Workbench 的 W3 在本地分支 `deployer-w3-maintenance` 上，未提交（见 Workbench 的 `docs/releases/1.25.0.zh-CN.md`）。

## 由清单生成 compose（§7.3，D11）

```sh
node bin/gen-compose.ts <清单目录> <环境设置.json> <输出目录>
npm test
```

- 清单：格式草案在 open-atlas-docs 的 `docs/proposals/deploy-manifest-v1.md`，四份初始清单在同目录 `deploy-manifests/`。
- 环境设置：[examples/uat.environment.json](examples/uat.environment.json)。包括项目名、端口绑定地址、登记的镜像仓库，以及每个应用部署的版本和本环境的覆盖值（宿主机端口、数据目录）。
- 生成结果：[examples/uat/](examples/uat/)。

### 服务器目录

```
/webapp/data/open-atlas/
├─ compose.yaml              # 只有 include，每个应用一项，带 env_file
├─ studio.env, workbench.env, dossier.env, logbook.env
├─ studio/
│  ├─ compose.yaml           # 生成的片段
│  ├─ data/                  # 数据目录（清单 volumes.path，相对应用目录）
│  └─ files/                 # 当前版本的发布文件（清单 volumes.file，只读挂载）
└─ …
```

### 生成规则

| 项 | 规则 |
|---|---|
| 镜像 | 公共镜像照清单写；公司镜像 = 登记的仓库前缀 / 镜像名 : 部署的版本 |
| 重启、日志 | 一律 `restart: unless-stopped`，日志 `local` 驱动，50 MB × 3 |
| 标签 | `org.open-atlas.app` / `component` / `version`，Deployer 读实际状态时用 |
| 端口 | 只发布清单里有宿主机端口的，绑定到环境的 `bindIp`；环境可按容器端口覆盖 |
| 数据目录 | `./<path>`，相对应用目录；环境可按容器路径覆盖成绝对路径 |
| 发布文件 | `./files/<file>`，只读 |
| env | 根文件 `include` 的 `env_file` 提供片段里 `${KEY}` 的取值；`envFile: true` 的服务另把整份文件传给容器 |
| 依赖 | 同一应用里的 `compose-service` 依赖：对方有健康检查等 `service_healthy`，没有等 `service_started` |
| 健康检查 | `image` 用镜像自带的；命令形式生成 `healthcheck`（10s 间隔、5s 超时、30 次） |
| 附加字段 | 清单的 `compose` 深合并进生成的服务 |
| 冲突 | 服务名、宿主机端口在所有应用之间唯一，冲突时拒绝生成 |

### 校验结果（2026-10-30，WSL Ubuntu 26.04，Docker 29.9.2，Compose 5.6.1）

用 `examples/uat/` 加占位 env 文件跑 `docker compose config`：

- 通过：10 个服务、10 个镜像全部解析。
- 每个片段的相对路径解析到自己的应用目录（如 `logbook/data/pg`、`dossier/files/deploy/Caddyfile`），端口都绑定在 `127.0.0.1`。
- `${KEY}` 只从本应用的 env 文件取值：从 `logbook.env` 删掉 `JWT_SECRET`、放进 `dossier.env`，Logbook 拿到的是空值，不会串用 Dossier 的。
- 缺 env 文件时直接报错；**缺某个变量只警告并取空字符串**。所以部署前 Deployer 要自己检查片段引用的每个 `${KEY}` 都在 env 文件里，缺了就拒绝（§7.2 的 env 校验做这件事）。

### 还没做

- **跨应用的启动顺序**：比如 Workbench 依赖 Studio 的数据面，compose 表达不了。阶段 2 每次只部署一个应用，顺序由人决定；多个应用一起部署时由计划排序。

（数据目录属主已在阶段 2 由执行器处理：新建的目录按镜像的 `USER` 设属主。）

## 多台服务器、HTTPS 入口、环境变量页改版（D35、D36、D37，2026-10-31）

设计见设计文档 §7.4 和 §7.2。

### 每台机器一个执行器，执行器主动连 Deployer（D35）

- `environment.json` 加 `hosts`（机器名 → `{ "address", "bindIp"?, "project"? }`），应用加 `host`（按应用放置）。不写 `hosts` 就是一台叫 `local` 的机器。
- 交接改成 HTTPS（协议 2），Deployer 从不连服务器，服务器不开端口：

| 接口（执行器 → Deployer） | 内容 |
|---|---|
| `GET /executor/v1/jobs/next?wait=25` | 长轮询，只领派给本机的任务；没有任务回 204 |
| `PUT /executor/v1/jobs/<id>/status` | 状态、步骤、结果；只能改本机的任务 |
| `POST /executor/v1/jobs/<id>/log` | 日志分段追加（只留最后 2 MB）；`compose config` 的输出不记录 |
| `PUT /executor/v1/jobs/<id>/env-content` | 读 env 任务的文件内容，Deployer 只取一次，10 分钟后丢弃 |
| `POST /executor/v1/heartbeat` | 版本、协议、任务种类、部署根目录、是否在忙 |
| `POST /executor/v1/state` | 本机容器（`docker ps` JSON 行）和 Deployer 写的文件的 SHA-256 |

- 凭据：`dpe_` 开头，每台机器单独签发（Hosts 页，admin、只限浏览器会话；或 `bin/executor-token.ts`），Deployer 只存哈希，可按机器吊销。写 env 的任务里的文件内容和请求分开存，执行器领走时一起删除。
- 每台机器一个 compose 项目，根文件只含放在这台的应用；端口、服务名、数据目录的冲突按台检查（注册表仍要求各清单的默认宿主机端口不重复，环境可以按台覆盖成相同端口）。
- 执行器（0.5.0）：Deployer 连不上时等待重试（不退出），凭据被拒才退出；正在执行的任务记在 `<EXECUTOR_WORK>/current-job.json`，重启后报为中断。共享目录方式已删除。
- 状态页按机器显示执行器、加"主机"列；新的 Hosts 页列出每台机器的执行器、应用、上报时间和凭据，admin 在这里签发、吊销。
- 应用换了机器：计划提示旧机器上的容器 Deployer 不会停，验证新机器后要手工 `docker compose down`，有数据目录的先拷过去。

### HTTPS 入口（D36）

- 一个环境一个域名（`domain`），应用的 `ingress`：`{ "kind": "nginx", "port": 8787, "path"?, "component"?, "containerPort"?, "maxBodySize"? }` 或 `{ "kind": "direct" }`，不写就是不对外。经 nginx 的地址是 `https://<domain>:<port><path>`，直连的是 `http://<机器地址>:<发布端口>`。
- 应用之间互相引用写 `{{app:<id>.url}}` 或 `{{app:<id>.origin}}`：在清单的 `environment` 和 env 文件的值里都可以用，Deployer 生成片段、写 env 文件时换成实际地址；解析不了就拦住部署和写入。
- nginx 由运维维护：Ingress 页生成推荐配置（每个端口一个 server，按路径分 location，长的路径在前；关缓冲、600 秒读超时、WebSocket、上传大小），存成修订（谁、何时、为什么），显示和上一修订的差异，可下载。部署走 nginx 的应用时，配置和最新修订不一致就在计划里提示。
- 容器里的 DNS 不认识域名时（内网没有这条记录、或本地试用），环境写 `extraHosts`（如 `["uat.example.com:10.0.0.5"]`、`["oa.localhost:host-gateway"]`），加到每个容器的 `/etc/hosts`（2026-11-01）。
- 机器把端口绑在 127.0.0.1（`bindIp`）时，nginx 只能在这台机器上、转发到 127.0.0.1，推荐配置在这个应用的注释里写明（2026-11-01）。
- 内部 CA：admin 在 Ingress 页贴 PEM 证书；之后每次部署把它写到 `<应用>/ca/ca.pem`，只读挂到容器的 `/etc/open-atlas/ca.pem`，并设 `NODE_EXTRA_CA_CERTS`（加在系统 CA 之外）；JVM 应用要在 env 文件里用 `JAVA_OPTS` 指向 truststore。应用可以在环境里写 `"ca": false` 不挂。
- 部署成功后经对外地址访问一次（信任内部 CA）：除 502/503/504 外的回答都算通；不通只在任务页提示"已部署，入口不通"并记审计，不回滚。
- 地址变了：计划列出引用它的应用（要重写 env、重启），并提醒存在应用自己数据库里的地址要手工改（Workbench 的 OMA Integration、OMA 里 agent 的 MCP 地址和 Vault 凭据）。

### 环境变量页（D37）

应用卡片（是否部署、导入与否、未写入的修订、缺几个键）；状态条写明服务器上的版本、Deployer 里的版本和下一步（先导入 / 查看计划并写入 / 编辑）；可点的数字筛选（已设置、缺少、密钥、未知或改名、可选未设）和按键名搜索；表格按"需要处理 / 已设置 / 可选未设"分组，问题标在行上；在同一张表里编辑，底部固定操作栏；历史和对比各在一个子标签里。

### 测试与验证（2026-10-31）

- `npm test` 83 个（2026-11-01 加 `extraHosts`、回环地址的上游、移出环境的机器不再算进状态页，以及执行器升级；2026-11-02 加 Deployer 升级、执行器断开的长轮询不再领任务、紧急密码哈希不含 `$`、未部署的已登记应用不再让漂移检查报错），执行器单元测试 31 个（执行器升级：装好切换后退出、新版本回报成功并清理旧版本、退回后旧版本回报失败、哈希和文件和版本号不对就拒绝、GitHub 来源；Deployer 升级：停机备份后切换、新版不应答就带着旧状态回退、动手前拒绝、Deployer 不在时状态存下再补发）。
- 2026-11-02 WSL 端到端（D16）：本地 Deployer 改成执行器管理的容器（`/webapp/deployer`，即部署根目录下的 `deployer/`）；执行器 0.6.0 → 0.7.0 自升级；Deployer 0.1.0-beta.1 → beta.2 成功（新版以 beta.2 应答心跳，停机期间的状态事后补发）；升到故意起不来的 beta.3 时重启 6 次后判失败，换回 beta.2 并恢复升级前的状态库（`environment.json` 校验和不变），任务记为已回滚。试用中发现并修了两处：执行器重启时，它留在 Deployer 的长轮询仍会领走任务、任务从此没人执行；compose 读 `deployer.env` 会把紧急密码哈希里的 `$` 当变量。新增：执行器凭据和长轮询、只领本机任务、别的机器改不了、吊销后拒绝、状态带机器名；按台生成根文件、同端口不同台不冲突；地址解析、引用解析不了时拦住；nginx 配置按端口和路径、修订和差异、下载；内部 CA 的挂载和请求；部署后复查失败只告警；地址和机器变化的提示；执行器的 HTTP 收发、中断标记、日志不含 env 内容。
- WSL 本地试用切到协议 2：本机执行器经 HTTP 在线、上报 4 个容器，导入 oma.env 成为修订 1。再模拟第二台机器 app2（单独的根目录、compose 项目和凭据，第二个执行器进程），登记一个 busybox 测试应用放在 app2、直连入口：部署成功，根文件只含它，复查 HTTP 200；改到 local 后计划提示换机器和地址变化。验证完删除了测试应用、app2 的执行器、凭据和目录，环境配置恢复原样。
- WSL 本地试用改成全部经 nginx（2026-11-01）：apt 装的 nginx 1.28 以用户身份运行，测试 CA 签 `oa.localhost` 的证书；环境写 `domain`、`nginx` 证书路径、`extraHosts` 和三个应用的 `ingress`（Workbench 8443、Studio 9443、OMA 9787，Deployer 手写在 8495 的 `/deploy/`）。Ingress 页保存的修订 1 原样放进 nginx，`nginx -t` 通过；Studio 设 `OPEN_ATLAS_STUDIO_TLS=off`，Workbench、OMA 的对外地址改成 `{{app:<id>.url}}`，经 env 页写入后重新部署。结果：经 nginx 的四个地址在 WSL 和 Windows 都返回 200；部署后复查（信任内部 CA）三个应用都 200；容器里 `oa.localhost` 经 `extraHosts` 解析到宿主机，用挂进去的 CA 访问别的应用的 https 地址 200，去掉 CA 则证书校验失败；Workbench 登录的 Cookie 带 `Secure`，同一个 Cookie 在 8495 上的 Deployer 认得出（Cookie 不分端口）；Workbench 的 SSE 经 nginx 即时到达。没测：WebSocket（现有应用没有用到）、浏览器里的页面（Windows 没导入测试 CA）。


## 管理工具、环境设置入库、平台升级入口（D38、D39，2026-11-02）

### 环境设置收进状态库（D38 ①）

- 新表 `environment_revisions`，只增不删，每次保存记谁、何时、经什么（页面 / key）、note、改了哪些路径（如 `apps.shop.version`）。第一次启动时把 `environment.json` 导入为修订 1（启动日志写明），之后以库为准；文件和最新修订不一致时，页面提示（不自动覆盖）。
- 页面：左侧"Environment settings"，整份 JSON 编辑、Check（finding 和差异）、带 note 保存为新修订；修订列表、查看旧修订、导出。只有管理员能改，PROD 和 UAT 都能改。
- 接口：`GET /api/environment[?revision]`、`POST /api/environment/validate`、`PUT /api/environment`（`{ base, patch | environment, note }`，base 不是最新返回 409，finding 返回 400）、`GET /api/environment/export`。
- 计划和部署读最新修订；部署请求带 `environmentRevision`，部署记录（`deployment-receipt`）加 `environment_revision` 和 `manifest_ref`。
- 新增机器（Hosts 页没有"新增"）：在这里的 `hosts` 里加，再到 Hosts 页签发凭据。

### 清单（D38 ②③⑥）

- `PUT /api/apps/:id/manifests`：`{ manifest | patch, appliesFrom?, newAppliesFrom?, base, note }`。改现有一段要带它最新的修订号作 base，不是最新返回 409（页面保存也带）；patch 是对 base 修订的 JSON Patch，必须用 `appliesFrom` 指明哪一段，改 `appliesFrom` 要用 `newAppliesFrom` 另起一段。`POST …/manifests/validate` 不保存，返回合并后的清单、finding、提醒（换来源要在 UAT 重新验证）、差异，以及这一段覆盖的版本：已部署过的（保留当时的修订，D31）和从没部署过的（会按这份部署）。页面"Check"后再保存。
- 改 `release.repo` 允许了，但只在页面上由管理员勾选确认（工具里给 finding），审计记 `app.repo-change`。
- PROD 上清单只读（保存返回 403）。PROD 计划用 UAT 那次部署记录里的清单修订（UAT 没部署过时用 UAT 现在覆盖这个版本的那份），从 UAT 的只读接口取来、按 UAT 的修订号存在本地；本地同号修订内容不同就拦住（`deploy/manifest-uat-mismatch`）。登记页在 PROD 有"Take from UAT"，一次取齐 UAT 各应用各段最新的清单。UAT 新增只读接口 `/api/peer/apps`、`/api/peer/apps/:id/manifests/:from/:revision`、`/api/peer/apps/:id/manifest?version=`。

### MCP 管理工具（D38）

- 只对 Workbench 管理员的个人 key 可见（服务 key、非管理员看不到）：`get_manifest`、`validate_manifest`、`save_manifest`、`get_environment`、`validate_environment`、`save_environment`、`get_ingress`、`get_nginx_config`、`save_nginx_config`、`list_hosts`、`revoke_host_token`、`list_keys`、`revoke_key`、`list_audit`（可按 actor、action、target、since 筛选）。每个都是页面同一个接口；写工具必须带 note 和 request_id，审计记 `mcp.<工具>` 和 note。
- `destructiveHint` 分开标：保存类 false（不碰服务器，下次部署才生效），吊销类 true。签发执行器凭据、发起升级、查看密钥原值、生成 key、移除应用、改仓库都不做成工具。golden cases 见 [docs/golden-cases.md](docs/golden-cases.md)"管理工具"。

### 平台升级入口（D39）

- Overview 顶部"Platform"区，和下面的应用分开；都是最新时折叠成一行。所有人能看，升级只限管理员的浏览器会话。Hosts 页不再有升级按钮。
- Deployer：版本下拉框来自 `DEPLOYER_RELEASE_REPO`（GitHub tag，格式 `DEPLOYER_RELEASE_TAG`），最新的在上，标 latest / newer / older (go back) / pre-release / running；预发布显示但不提醒；没配或连不上时手填。"Review upgrade"出计划（`GET /api/deployer/plan`：版本、机器、镜像、GitHub release 说明、步骤、拦住的原因、退回旧版的提示），确认后才升级；退回旧版要再确认一次（接口要 `confirmOlder`）。升级期间页面每 15 秒问一次 `/api/me`，版本变了就整页刷新。
- 执行器：每台一行；"Upgrade outdated"（`POST /api/hosts/upgrade-outdated`）一台一台升，前一台成功才排下一台（Deployer 在任务结束时排），失败或退回就停，剩下的不动；进度存在设置里，页面显示。
- `/api/platform` 给 Overview 用；`/api/me` 带 `deployerVersion`。

### 测试与验证（2026-11-02）

- `npm test` 88 个，新增：环境设置的导入、base、patch、finding、校验不保存、文件不同的提示、部署记录带修订号；清单的分段、base、patch、不许在 patch 里改 appliesFrom、受影响版本、换来源提醒、另起一段、改仓库的确认；PROD 随晋级取 UAT 的清单修订、PROD 只读、同号修订不一致时拦住、从 UAT 取登记；管理工具的可见性、`destructiveHint`、save 的 finding、审计带 note、审计筛选；平台的版本列表和标注、升级计划、退回旧版要确认、执行器一台一台升、失败就停。
- WSL：用这份代码构建 0.1.0-beta.4、beta.5，经执行器升级本地 Deployer 成功；新版本启动时把 `environment.json` 导入为修订 1。页面上的平台区、环境设置页和登记页的新流程没在浏览器里看过（Windows 没导入测试 CA、我不处理登录凭据）；MCP 管理工具只有单元测试，没用真实的管理员 key 跑过。
