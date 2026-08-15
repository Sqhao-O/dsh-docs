# dsh-docs

[English](README.md) | [安装提示词](INSTALL.md)

**dsh-docs** 让 DeepSeek Harness 代理拥有真正的本地文档理解能力——全部在你
自己的机器上完成。把 PDF、Word、Excel、PowerPoint 交给它，即可拿回干净的
Markdown、纯文本或结构化 JSON；把扫描件或图片交给它，完全离线的 OCR 流水线
会直接读出其中的文字。无需 Docker、无需 HTTP 服务、无需 API Key，文档永不
离开你的磁盘。

它随附固定版本、自包含的 Python + [Xberg](https://github.com/xberg-io/xberg)
运行时，内置离线 Tesseract 语言数据（英文与简体中文），在 Windows x64 上开箱
即得完整的 PDF/Office/OCR 能力；原生 Xberg Node 绑定则作为任意平台上轻量的非
OCR 解析回退。所有文件读取都被严格限制在你显式授权的目录之内。

发布包名、插件 id 与 `dshdoc_*` 工具名统一采用 `dsh-doc` / `dshdoc` 拼写，
由初版的 `dsh-docling` / `docling_*` 更名而来。

## 一段提示词完成安装

无需提前克隆本仓库，也不需要构建工具链。把下面这段提示词直接粘贴到你自己项目
文件夹中正在运行的 DSH 会话（例如 `dsh web`）里，Harness 代理会一次性完成 npm
包安装、固定哈希的离线 OCR 运行时下载与插件配置。唯一前置条件是可用的 `dsh`
CLI（Node `^22.19` 或 `>= 24`）；所有运行时步骤都是纯 Node.js 脚本，cmd、
PowerShell、pwsh、Git Bash 均可运行。

```text
请把 dsh-doc 插件端到端安装到我的 DSH web profile，所有步骤由你在终端里
完成并验证结果。

1. 安装已发布的插件包：
   dsh plugin --profile web add dsh-doc
2. 仅 Windows x64 —— 下载预构建的离线 OCR 运行时。脚本会校验固定的压缩包
   SHA-256，并依据随包 manifest 校验解压后的每个文件：
   node <home>/.dsh/profiles/web/node_modules/dsh-doc/scripts/fetch-runtime-win32-x64.mjs <home>/.dsh/runtimes/dshdoc-runtime-win32-x64
   把 <home> 替换成我的主目录绝对路径，之后所有步骤都使用这个路径。
   其他平台跳过此步，并在下面改用 engine: node。
3. 编辑 <home>/.dsh/profiles/web/cordis.patch.yml：保留已有的全部条目，新增或
   更新下面这一条：
   - id: dsh-doc
     config:
       engine: python
       runtimeDir: <home>/.dsh/runtimes/dshdoc-runtime-win32-x64
       defaultOcr: true
       maxOutputChars: 32000
   会话工作区自动可读；allowedLocalRoots 只用于共享文档库等额外持久目录。
   若跳过了第 2 步，改用 `engine: node`、`defaultOcr: false`，并省略 runtimeDir。
4. 运行 `dsh --profile web --dump-config` 验证合成后的 dsh-doc 条目与上面
   的配置完全一致，然后报告结果，并提醒我重启 `dsh web` 后用 dshdoc_health 测试。

硬性约束：绝不安装、启动或配置 Docling Serve、Docker、容器或任何远程文档转换
服务；绝不配置可下载的 OCR 后端或允许模型下载。
```

代理完成并重启 `dsh web` 后，先用 `dshdoc_health` 检查引擎，再用
`dshdoc_extract` 解析工作区下的任意文件。[INSTALL.md](INSTALL.md) 记录了同样的
流程以及逐步手动安装方式。

## 已覆盖的能力

- PDF、DOCX、XLSX、PPTX、Markdown、HTML、CSV、纯文本
- PNG、JPEG、TIFF、WebP 与扫描 PDF 的本地 OCR
- 返回给模型的 Markdown、文本或 JSON 结构化 Tool Result

测试会在系统临时目录动态生成 PDF、DOCX、XLSX、PPTX、PNG 与扫描 PDF；这些二进制
样本不会进入 Git，并且已由真实 Xberg / Python worker 解析验证。

## 通过 `dsh web` 快速使用

把已发布的包装进 `web` profile：

```text
dsh plugin --profile web add dsh-doc
```

仅 Windows x64 —— 把预构建的离线 OCR 运行时下载到 `node_modules` 之外的稳定
目录（避免插件升级时被删除）：

```text
node ~/.dsh/profiles/web/node_modules/dsh-doc/scripts/fetch-runtime-win32-x64.mjs ~/.dsh/runtimes/dshdoc-runtime-win32-x64
```

请把所有位置（包括 YAML 内）的 `~` 展开为你的主目录绝对路径。其他平台跳过
运行时，改用 `engine: node` 和 `defaultOcr: false`。

在 web profile 的 `cordis.patch.yml` 中添加插件条目：

```yaml
- id: dsh-doc
  config:
    engine: python
    runtimeDir: ~/.dsh/runtimes/dshdoc-runtime-win32-x64
    # 已配置 runtime 内含本地语言包，因此可以安全开启。
    defaultOcr: true
    defaultTableMode: accurate
    maxOutputChars: 32000
```

会话工作区无需配置即可读取；`allowedLocalRoots` 只用于工作区之外的额外持久
目录，`allowWorkspaceFiles: false` 仅用于纯白名单锁定的部署。

重启 `dsh web` 后可直接说：

```text
阅读 ./reports/annual-report.pdf，列出三个主要风险。
提取 ./financials.xlsx 的表格。
读取 ./scanned-invoice.png 的文字。
```

相对路径按 DSH 会话工作目录解析；只有会话工作目录或 `allowedLocalRoots` 下的文件可读取。

## 内嵌 Python / OCR 运行时（Windows x64）

多数用户直接从 GitHub Release 下载预构建、固定哈希的运行时：

```text
node ./scripts/fetch-runtime-win32-x64.mjs
```

如需自行审计并从源码构建，则运行：

```text
node ./scripts/build-runtime-win32-x64.mjs
```

两种命令都会在 Git 忽略的 `.dsh-runtime/runtime-win32-x64` 下生成 CPython 3.11.9、
`xberg==1.0.14` 与固定的 `eng` / `chi_sim` Tesseract 模型。每个下载均校验 SHA-256，
并生成 manifest、NOTICE、SPDX 清单；不会改动全局 Python。
将运行时复制到其他机器后，应先运行
`node ./scripts/verify-runtime-win32-x64.mjs` 校验所有 payload 哈希。

将插件指向该运行时：

```yaml
- id: dsh-doc
  config:
    engine: python
    runtimeDir: <运行时目录的绝对路径>
```

Python worker 只经 stdio 接收文件字节快照、显示名称、MIME 与选项，从不接收用户路径
或 URL。它默认离线，缺少语言模型会安全失败，并禁用文档派生 OCR 缓存；`dshdoc_health`
会报告可用 OCR 语言。详见
[运行时构建说明](docs/runtime-win32-x64.md)。

### 仅 Node 回退

只有需要 PDF/Office/文本的非 OCR 解析时才设为 `engine: node`。其 `defaultOcr` 默认
为 `false`。若要启用 Node OCR，必须设置指向已审核本地
`<language>.traineddata` 文件的 `tessdataPath`；缺少模型固定返回
`ENGINE_OCR_UNAVAILABLE`，绝不会下载模型。完整离线 OCR 请使用上面的 Python 运行时。

## 工具

| 工具 | 用途 |
| --- | --- |
| `dshdoc_health` | 检查当前本地解析引擎是否就绪。 |
| `dshdoc_convert_file` | 解析白名单中的本地文件。 |
| `dshdoc_extract` | 推荐的本地文件便捷工具。 |
| `dshdoc_convert_url` | 兼容占位工具，固定返回 `UNSUPPORTED_URL`。 |

HTTP(S) 输入只会被安全识别并拒绝。若要解析远程文档，请先用已审核的下载流程保存到
允许目录，再调用本插件；插件绝不会把 URL 交给 Xberg/Python，避免重定向与 DNS
重绑定风险。

`page_range` 使用从 1 开始、两端包含的页码范围，适用于 Markdown 和纯文本结果；JSON
输出会刻意保留完整的结构化文档。

转换工具还支持按请求传入 `ocr_languages` 数组（例如 `["chi_sim", "eng"]`），临时覆盖
配置的语言集。引擎上报时，结果会标注 `OCR: applied` / `OCR: not used`；开启 OCR 不会
再覆盖 PDF 完好的内嵌文本层。

## 核心配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `engine` | `auto` | `node`、`python` 或 `auto`；auto 优先使用已配置的内嵌 Python，否则使用 Node Xberg。 |
| `runtimeDir` | 未设置 | 内嵌运行时绝对路径。 |
| `pythonCommand` | 未设置 | 受信任的 Python 可执行程序。 |
| `pythonWorkerPath` | 随包 worker | Python worker 的绝对路径覆盖。 |
| `tessdataPath` | runtime `ocr/tessdata` | 内置 Tesseract 语言数据目录。 |
| `ocrBackend` | `auto` | `auto` 或 `tesseract`；两者均选择固定的本地 Tesseract 后端。 |
| `ocrLanguages` | 运行时内全部语言包 | 本地 OCR 语言包顺序；不配置时使用运行时捆绑的全部 `.traineddata` 包。 |
| `defaultOcr` | `false` | 图片/扫描件的 OCR 默认值；只应在已配置本地 tessdata runtime 时开启。 |
| `allowedLocalRoots` | `[]` | 会话工作区之外，模型可读取的额外绝对、非根目录。 |
| `allowWorkspaceFiles` | `true` | 隐式授权会话工作区（session cwd）为可读根；设为 `false` 则回到纯白名单锁定。 |
| `maxFileBytes` | `52428800` | 授权输入文件的大小上限。 |
| `maxOutputChars` | `32000` | 返回给模型的最大字符数。 |

旧 profile 中的 `baseUrl`、`apiKey`、`enableRemoteUrls`、`allowPrivateUrls` 仅为迁移
兼容而接受，不能重新开启远程解析。

## 安全边界

- 路径会 realpath 后比对全部白名单根目录，以及（除非禁用 `allowWorkspaceFiles`）会话工作区，
  阻断 `..`、符号链接逃逸、根目录、非文件与超大文件。
- 授权后立即从文件描述符读取一次字节快照，防止文件随后被替换。
- Node 与 Python 引擎都只解析 bytes；插件不创建监听端口、URL 下载器、容器或外部服务。
- 本版本只开放 Tesseract OCR。所有请求的语言包均从配置的本地运行时读取；缺失时安全失败，
  不会触发模型下载。
- 用于解析的已打开文件描述符必须与 open 后仍在白名单内的路径具有相同 device/inode 身份，
  阻断授权与读取之间的文件替换。
- 结果在成为 Tool Result 前限长；JSON 限制时采用模型真正看到的格式化文本。

## 开发验证

```text
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

测试覆盖本地 Node Xberg、Python stdio worker、离线语言数据 OCR、Cordis ToolRuntime
以及 DSH AgentLoop 下一轮上下文注入。
