# dsh-docling

[English](README.md) | [安装提示词](INSTALL.md)

**dsh-docling** 让 DeepSeek Harness 代理拥有真正的本地文档理解能力——全部在你
自己的机器上完成。把 PDF、Word、Excel、PowerPoint 交给它，即可拿回干净的
Markdown、纯文本或结构化 JSON；把扫描件或图片交给它，完全离线的 OCR 流水线
会直接读出其中的文字。无需 Docker、无需 HTTP 服务、无需 API Key，文档永不
离开你的磁盘。

它随附固定版本、自包含的 Python + [Xberg](https://github.com/xberg-io/xberg)
运行时，内置离线 Tesseract 语言数据（英文与简体中文），在 Windows x64 上开箱
即得完整的 PDF/Office/OCR 能力；原生 Xberg Node 绑定则作为任意平台上轻量的非
OCR 解析回退。所有文件读取都被严格限制在你显式授权的目录之内。

## 一段提示词完成安装

无需提前克隆本仓库。把下面这段提示词直接粘贴到你自己项目文件夹中正在运行的
DSH 会话（例如 `dsh web`）里，Harness 代理会一次性完成克隆、构建、注册与配置。
前置条件：`git`、`pnpm` ≥ 10、Node `^22.19` 或 `>= 24`，Windows x64 上还需要
PowerShell 7+。

```text
请把 dsh-docling 插件端到端安装到我的 DSH web profile，所有步骤由你在终端里
完成并验证结果。

1. 克隆仓库（目录已存在则跳过此步）：
   git clone https://github.com/Sqhao-O/dsh-docling.git <home>/.dsh/plugins/dsh-docling
   把 <home> 替换成我的主目录绝对路径，之后所有步骤都使用这个克隆目录的绝对路径。
2. 构建插件：在克隆目录里运行 `pnpm install`（其 prepare 脚本会编译 lib/），
   完成后确认 lib/index.js 存在。
3. 仅 Windows x64 —— 构建离线 OCR 运行时（每个下载文件都做 SHA-256 固定校验）：
   pwsh -File <clone>/scripts/build-runtime-win32-x64.ps1
   其他平台跳过此步，并在下面改用 engine: node。
4. 把插件注册到我的 web profile：
   dsh plugin --profile web add <clone>
5. 编辑 <home>/.dsh/profiles/web/cordis.patch.yml：保留已有的全部条目，新增或
   更新下面这一条，把 <clone> 和 <workspace> 替换为绝对路径（<workspace> 是我
   当前的工作目录）：
   - id: dsh-docling
     config:
       engine: python
       runtimeDir: <clone>/.dsh-runtime/runtime-win32-x64
       allowedLocalRoots:
         - <workspace>
       defaultOcr: true
       maxOutputChars: 32000
   若跳过了第 3 步，改用 `engine: node`、`defaultOcr: false`，并省略 runtimeDir。
6. 运行 `dsh --profile web --dump-config` 验证合成后的 dsh-docling 条目与上面
   的配置完全一致，然后报告结果，并提醒我重启 `dsh web` 后用 docling_health 测试。

硬性约束：绝不安装、启动或配置 Docling Serve、Docker、容器或任何远程文档转换
服务；绝不配置可下载的 OCR 后端或允许模型下载；不要把克隆目录里的
.dsh-runtime/ 产物提交进 Git。
```

代理完成并重启 `dsh web` 后，先用 `docling_health` 检查引擎，再用
`docling_extract` 解析工作区下的任意文件。[INSTALL.md](INSTALL.md) 记录了同样的
流程以及逐步手动安装方式。

## 已覆盖的能力

- PDF、DOCX、XLSX、PPTX、Markdown、HTML、CSV、纯文本
- PNG、JPEG、TIFF、WebP 与扫描 PDF 的本地 OCR
- 返回给模型的 Markdown、文本或 JSON 结构化 Tool Result

测试会在系统临时目录动态生成 PDF、DOCX、XLSX、PPTX、PNG 与扫描 PDF；这些二进制
样本不会进入 Git，并且已由真实 Xberg / Python worker 解析验证。

## 通过 `dsh web` 快速使用

以下示例假设克隆目录为 `~/.dsh/plugins/dsh-docling`；请把所有位置（包括 YAML
内）的 `~` 展开为你自己克隆目录的绝对路径。

先构建离线 Python 运行时：

```powershell
pwsh -File ./scripts/build-runtime-win32-x64.ps1
```

再将本地插件安装到 `web` profile：

```powershell
dsh plugin --profile web add ~/.dsh/plugins/dsh-docling
```

在 web profile 的 `cordis.patch.yml` 中设置最小白名单：

```yaml
- id: dsh-docling
  config:
    engine: python
    runtimeDir: ~/.dsh/plugins/dsh-docling/.dsh-runtime/runtime-win32-x64
    allowedLocalRoots:
      - D:/Dev/Projects/my-workspace
    # 已配置 runtime 内含本地语言包，因此可以安全开启。
    defaultOcr: true
    defaultTableMode: accurate
    maxOutputChars: 32000
```

重启 `dsh web` 后可直接说：

```text
阅读 ./reports/annual-report.pdf，列出三个主要风险。
提取 ./financials.xlsx 的表格。
读取 ./scanned-invoice.png 的文字。
```

相对路径按 DSH 会话工作目录解析；只有 `allowedLocalRoots` 下的文件可读取。

## 内嵌 Python / OCR 运行时（Windows x64）

构建独立、离线优先的运行时产物：

```powershell
pwsh -File ./scripts/build-runtime-win32-x64.ps1
```

该脚本在 Git 忽略的 `.dsh-runtime/runtime-win32-x64` 下生成 CPython 3.11.9、
`xberg==1.0.14` 与固定的 `eng` / `chi_sim` Tesseract 模型。每个下载均校验 SHA-256，
并生成 manifest、NOTICE、SPDX 清单；不会改动全局 Python。
将运行时复制到其他机器后，应先运行
`pwsh -File ./scripts/verify-runtime-win32-x64.ps1` 校验所有 payload 哈希。

将插件指向该运行时：

```yaml
- id: dsh-docling
  config:
    engine: python
    runtimeDir: ~/.dsh/plugins/dsh-docling/.dsh-runtime/runtime-win32-x64
    allowedLocalRoots:
      - D:/Dev/Projects/my-workspace
```

Python worker 只经 stdio 接收文件字节快照、显示名称、MIME 与选项，从不接收用户路径
或 URL。它默认离线，缺少语言模型会安全失败，并禁用文档派生 OCR 缓存；`docling_health`
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
| `docling_health` | 检查当前本地解析引擎是否就绪。 |
| `docling_convert_file` | 解析白名单中的本地文件。 |
| `docling_extract` | 推荐的本地文件便捷工具。 |
| `docling_convert_url` | 兼容占位工具，固定返回 `UNSUPPORTED_URL`。 |

HTTP(S) 输入只会被安全识别并拒绝。若要解析远程文档，请先用已审核的下载流程保存到
允许目录，再调用本插件；插件绝不会把 URL 交给 Xberg/Python，避免重定向与 DNS
重绑定风险。

`page_range` 使用从 1 开始、两端包含的页码范围，适用于 Markdown 和纯文本结果；JSON
输出会刻意保留完整的结构化文档。

## 核心配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `engine` | `auto` | `node`、`python` 或 `auto`；auto 优先使用已配置的内嵌 Python，否则使用 Node Xberg。 |
| `runtimeDir` | 未设置 | 内嵌运行时绝对路径。 |
| `pythonCommand` | 未设置 | 受信任的 Python 可执行程序。 |
| `pythonWorkerPath` | 随包 worker | Python worker 的绝对路径覆盖。 |
| `tessdataPath` | runtime `ocr/tessdata` | 内置 Tesseract 语言数据目录。 |
| `ocrBackend` | `auto` | `auto` 或 `tesseract`；两者均选择固定的本地 Tesseract 后端。 |
| `ocrLanguages` | `[eng]` | 本地 OCR 语言包顺序。 |
| `defaultOcr` | `false` | 图片/扫描件的 OCR 默认值；只应在已配置本地 tessdata runtime 时开启。 |
| `allowedLocalRoots` | `[]` | 模型可读取的绝对、非根目录白名单。 |
| `maxFileBytes` | `52428800` | 授权输入文件的大小上限。 |
| `maxOutputChars` | `32000` | 返回给模型的最大字符数。 |

旧 profile 中的 `baseUrl`、`apiKey`、`enableRemoteUrls`、`allowPrivateUrls` 仅为迁移
兼容而接受，不能重新开启远程解析。

## 安全边界

- 路径会 realpath 后比对全部白名单根目录，阻断 `..`、符号链接逃逸、根目录、非文件与超大文件。
- 授权后立即从文件描述符读取一次字节快照，防止文件随后被替换。
- Node 与 Python 引擎都只解析 bytes；插件不创建监听端口、URL 下载器、容器或外部服务。
- 本版本只开放 Tesseract OCR。所有请求的语言包均从配置的本地运行时读取；缺失时安全失败，
  不会触发模型下载。
- 用于解析的已打开文件描述符必须与 open 后仍在白名单内的路径具有相同 device/inode 身份，
  阻断授权与读取之间的文件替换。
- 结果在成为 Tool Result 前限长；JSON 限制时采用模型真正看到的格式化文本。

## 开发验证

```powershell
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

测试覆盖本地 Node Xberg、Python stdio worker、离线语言数据 OCR、Cordis ToolRuntime
以及 DSH AgentLoop 下一轮上下文注入。
