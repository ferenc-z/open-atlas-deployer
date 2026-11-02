# 发布 Open Atlas Deployer

推送 tag `v<版本>` 后，[.github/workflows/release.yml](../.github/workflows/release.yml) 会做五件事：

1. 核对版本：tag 和 `package.json` 一致，Deployer 自带的执行器版本（`src/server/handoff.ts` 的 `EXECUTOR_VERSION`）和 `executor/deployer_executor.py` 的 `VERSION` 一致。
2. 从 CHANGELOG 取出这个版本的说明（取不到就停），再跑类型检查、服务端测试，以及 Python 3.9 下的执行器测试。
3. 构建并推送镜像 `ghcr.io/ferenc-z/open-atlas-deployer:<版本>`。只有正式版另外推 `:latest`。
4. 如果 GitHub release `executor-v<执行器版本>` 还不存在，就打包执行器建这个 release，附件是 `open-atlas-deployer-executor-<版本>.tar.gz` 和 `SHA256SUMS`。
5. 建 GitHub release `v<版本>`，说明就是第 2 步从 [CHANGELOG.md](../CHANGELOG.md) 的 `## <版本>` 一节取出的内容。版本号带 `-` 的（比如 `0.1.0-rc.1`）标成 pre-release。

平时的检查由 [.github/workflows/ci.yml](../.github/workflows/ci.yml) 负责：每次推送都跑类型检查、测试、页面构建，执行器测试在 Python 3.9 和 3.12 上各跑一遍。

## 每次发布

```sh
# 1. 版本号：package.json 和 package-lock.json 一起改
npm version 0.1.0 --no-git-tag-version
# 2. CHANGELOG.md 加上 "## 0.1.0" 一节；执行器代码改了，就同时调 executor/deployer_executor.py 的 VERSION 和 handoff.ts 的 EXECUTOR_VERSION
# 3. 提交、推送分支，等 ci 通过
git push origin main
# 4. 打 tag 并推送，release 流程随之开始
git tag -a v0.1.0 -m "Open Atlas Deployer 0.1.0"
git push origin v0.1.0
```

发布完成后，管理员在各环境 Deployer 的 Overview → Platform 里就能看到新版本：先升 UAT，跑一段时间再升 PROD。执行器有新版本时，在同一个区域里升级。

## 第一次发布的注意事项

第一次发布要跑通整条链路，下面几项只需要做一次，漏了任何一项，发布或升级都会失败。

### GitHub 仓库

- **仓库是 `github.com/ferenc-z/open-atlas-deployer`**（本地 `origin` 已指向 `git@github.com:ferenc-z/open-atlas-deployer.git`），要先在 GitHub 上建好这个空仓库再推送。workflow 里的镜像地址取自仓库所有者，所以 Deployer 的镜像是 `ghcr.io/ferenc-z/open-atlas-deployer`，执行器的发布包在这个仓库的 release 里。应用的镜像仍在 `ghcr.io/gaojie197710-tech`，所以服务器上 `EXECUTOR_REGISTRIES` 两个都要写（空格分开），`EXECUTOR_DEPLOYER_IMAGE`、`EXECUTOR_UPGRADE_FROM` 指向 ferenc-z，见 [executor.env.example](../executor/executor.env.example)。
- **Actions 要能写。** workflow 自己声明了 `contents: write` 和 `packages: write`，但如果仓库或组织在 Settings → Actions → General → Workflow permissions 里把上限限成了只读，建 release 和推镜像都会失败。遇到这种情况，改成 "Read and write permissions"。
- **先让 ci 通过一次，再打 tag。** 第一次推送时就能看出 Actions 是否启用、Python 3.9 的测试能否通过。

### 镜像和 release 的访问权限

- **GHCR 的包第一次推送时默认是私有的。** 服务器拉镜像有两种办法：
  - 在每台服务器上 `sudo docker login ghcr.io`，用带 `read:packages` 权限的令牌（令牌由你自己创建和输入）；
  - 或者在 GitHub 的 Packages → open-atlas-deployer → Package settings 里把包改成公开。
  
  workflow 给镜像加了 `org.opencontainers.image.source` 标签，包会自动关联到仓库。注意：一台服务器对 `ghcr.io` 只存一份登录凭据，应用镜像（`gaojie197710-tech`）用的也是它。如果 Deployer 的包保持私有，这份凭据就得同时能读两个所有者的包，所以改成公开最省事。
- **建议把 `ferenc-z/open-atlas-deployer` 设成公开仓库。** Deployer 和执行器读 GitHub 都只有一个令牌文件（`DEPLOYER_GITHUB_TOKEN_FILE`、`EXECUTOR_GITHUB_TOKEN_FILE`），现在这个令牌是给 `gaojie197710-tech` 下的应用仓库用的。fine-grained 令牌只能授权一个所有者，读不到 `ferenc-z` 下的私有仓库。仓库公开后：
  - Deployer 读版本列表（`DEPLOYER_RELEASE_REPO`）和执行器下载升级包（`EXECUTOR_UPGRADE_FROM`）都不需要额外权限；
  - 镜像包也可以一起改成公开，服务器就不用为它 `docker login`。

  仓库必须私有的话，只能把现有令牌换成 classic 令牌（`repo` 权限，对两个所有者都能读），或者让 `ferenc-z` 成为 `gaojie197710-tech` 下仓库的协作者，再用一个能同时读两边的令牌。不配的话，版本下拉框会退回手填，执行器升级会报下载失败。

### 服务器上第一次安装

自升级只能从已经装好的版本开始，所以第一次全部要手工装：

1. **执行器**：从 release `executor-v0.7.1` 下载包，解压后运行 `sudo ./install.sh`，再编辑 `/etc/open-atlas-deployer/executor.env`，参照 [executor.env.example](../executor/executor.env.example)。0.6.0 以前的执行器都要这样手工装一次，之后才能在页面上升级。
2. **Deployer**：按 [examples/deployer](../examples/deployer) 布置目录。`.env` 里手写 `DEPLOYER_IMAGE=ghcr.io/ferenc-z/open-atlas-deployer:0.1.0-rc.3`，写死版本，不要用 `latest`；之后执行器升级时会改写这一行。
3. **让 Deployer 能自升级**：在运行 Deployer 的那台机器上，`executor.env` 里设 `EXECUTOR_DEPLOYER_DIR` 和 `EXECUTOR_DEPLOYER_IMAGE`，设 `EXECUTOR_UPGRADE_FROM=ferenc-z/open-atlas-deployer`，并且 `EXECUTOR_REGISTRIES` 要包含 `ghcr.io/ferenc-z`。改完重启执行器。
4. **在 Deployer 的设置里加 `DEPLOYER_RELEASE_REPO=github:ferenc-z/open-atlas-deployer`**，Overview 才会列出可选版本。

### 本地试验版本迁移过来时

- **紧急账号的哈希要换格式。** compose 读 `deployer.env` 时，会把值里的 `$` 当成变量替换掉，所以旧的 `scrypt$盐$值` 格式要改成 `scrypt:盐:值`，否则紧急账号登不上。
- **环境设置只在第一次启动时导入。** 新版 Deployer 第一次启动，会把 `environment.json` 导入状态库作为修订 1，启动日志里能看到这一行；之后改设置都在 Environment settings 页上做，再改这个文件不会生效。页面会提示文件和库里不一致。
- 状态库 `deployer.db` 原样沿用，新表由启动时自动建好。升级前照例备份 `data/`；D16 自升级会自动备份，手工升级则要自己备份。

### 出错时

- **tag 发出后就不要再挪。** 服务器可能已经按这个版本拉了镜像，换掉同名 tag 会让两边对不上。发布失败时，删掉失败的 release 和 tag，换下一个版本号重新发，比如 `rc.4`。
- **执行器的 release 只在不存在时才建。** 改了执行器代码却没调 `VERSION`，旧的 `executor-v…` release 会原样留着，服务器上的执行器也不会更新。调了 `VERSION`、却忘了同时改 `handoff.ts`，版本核对那一步就会失败。
- **CHANGELOG 没有这个版本的一节，或者版本号对不上**，流程会在最开始停下，镜像和 release 都还没生成。补上之后，删掉 tag 重新推即可；这是唯一可以重推同名 tag 的情况。
