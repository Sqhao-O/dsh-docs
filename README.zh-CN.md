# 📄 dsh-docling

[English](README.md) | [中文](README.zh-CN.md)

**面向 DeepSeek Harness 的原生文档智能插件。**
**由 Docling 驱动。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://img.shields.io/badge/CI-GitHub%20Actions-2088FF)](.github/workflows/ci.yml)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4b6bfb)](https://github.com/deepseek-ai/deepseek-harness)
[![Docling](https://img.shields.io/badge/Docling-Serve-0b7a75)](https://github.com/docling-project/docling-serve)
[![npm](https://img.shields.io/npm/v/dsh-docling)](https://www.npmjs.com/package/dsh-docling)

让 DeepSeek Harness 能够理解文档。

**PDF · DOCX · PPTX · XLSX · HTML · Markdown · CSV · 图片**

将 PDF、Office 文档和扫描件转换为可供 DeepSeek Harness 推理的结构化上下文。

## 一句话安装

### 直接交给 DSH 中的 AI

> 请按照 [INSTALL.md](https://github.com/Sqhao-O/dsh-docling/blob/main/INSTALL.md) 为当前 DSH profile 安装并配置 dsh-docling：只允许当前工作目录读取本地文档；使用我已运行的 Docling Serve，如缺少服务地址或 API key 才询问我；不要下载或启动 Docling，也不要拉取任何容器镜像；最后验证生成的 DSH 配置并报告结果。

该说明专为 DSH agent 编写，可以安全地重复执行。它只安装本 DSH 插件；Docling
Serve 始终由运维者管理。agent 确认 profile 配置完成后，重启 DSH 并说：
`检查 Docling 服务状态。`

<details>
<summary>手动安装</summary>

请查看下面的[快速开始](#快速开始)。

</details>

## 功能

- 支持 PDF、DOCX、PPTX、XLSX、HTML、Markdown、CSV、图片和扫描件
- 可控制 Docling OCR 与表格提取
- 使用基于 realpath 的本地目录白名单沙箱
- 对 HTTP/HTTPS 文档 URL 提供 DNS 感知的 SSRF 预检
- 原生 DSH Tool Result，包含结构化 canonical value 与可读渲染
- 可配置文件大小、超时和输出大小限制
- 插件本身不携带 Python 运行时、模型、OCR 或解析器

## 架构

```text
文档
   ↓
dsh-docling（TypeScript）
   ↓ HTTP
Docling Serve
   ↓
结构化 Markdown / text / JSON + 元数据
   ↓
DeepSeek Harness
   ↓
LLM 推理
```

## 快速开始

### 1. 启动 Docling Serve

使用 Python 安装并运行：

```bash
pip install "docling-serve[ui]"
docling-serve run
```

也可以使用上游容器镜像：

```bash
podman run -p 5001:5001 quay.io/docling-project/docling-serve
# Docker 可替代 Podman。
```

插件只需要一个可访问的 HTTP 服务端点；它不会自行安装 Python 或下载模型。

### 2. 手动安装 bundle

以下命令面向 `dsh web` 使用的 `web` profile。若使用其他 DSH 界面，请将
`web` 替换为对应的当前 profile 名称。

从 npm 安装：

```bash
dsh plugin --profile web add dsh-docling
```

或直接从 GitHub 安装（生产环境请固定 commit）：

```bash
dsh plugin --profile web add github:Sqhao-O/dsh-docling
```

Git 安装会通过 `prepare` 编译 TypeScript。pnpm 10+ 下，DSH 可能要求你在
profile 的 `pnpm-workspace.yaml` 中允许该可信构建。

### 3. 配置文档访问

bundle 会添加自己的 `dsh-docling` 配置项。请在 profile 的
`cordis.patch.yml` 中添加或覆盖配置；目录必须是绝对路径且不能是文件系统根目录。

```yaml
- id: dsh-docling
  config:
    baseUrl: http://127.0.0.1:5001
    # 仅当 DOCLING_SERVE_API_KEY 已配置时再设置 apiKey
    allowedLocalRoots:
      - C:/work/my-project
    maxFileBytes: 52428800
    maxOutputChars: 32000
    defaultOcr: true
    defaultTableMode: accurate
    defaultOutputFormat: md
```

无需启动界面即可验证生成的配置层：

```bash
dsh --profile web --dump-config
```

### 4. 让 Harness 阅读文档

```text
阅读 ./docs/report.pdf 并总结主要风险。

分析这份年报：
https://example.com/report.pdf

提取 ./financials.xlsx 中的表格。
```

模型通常应选择 `docling_extract`；它会自动判断来源是本地文件还是 URL。

## 工具

| 工具 | 用途 | 主要参数 |
| --- | --- | --- |
| `docling_health` | 检查配置的服务是否可访问。 | 无 |
| `docling_convert_file` | 转换白名单内的本地文档；适合 PDF、Word、PowerPoint、Excel 和扫描件。 | `path`、`output_format?`、`ocr?`、`table_mode?`、`page_range?` |
| `docling_convert_url` | 转换公开文档 URL。 | `url`、`output_format?`、`ocr?`、`table_mode?`、`page_range?` |
| `docling_extract` | 推荐的便捷工具；自动识别本地文件或 HTTP(S) URL。 | `source`、`source_type?`、`ocr?`、`table_mode?`、`page_range?` |

`output_format` 可取 `md`、`text` 或 `json`。`page_range` 是从 1 开始的闭区间
`[start, end]`。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:5001` | Docling Serve 基础 URL；仅 HTTP(S)。 |
| `apiKey` | 未设置 | 通过上游 `X-Api-Key` 请求头发送。 |
| `timeoutMs` | `120000` | 单次 HTTP 请求的截止时间。 |
| `maxFileBytes` | `52428800` | 上传前的文件大小上限（50 MiB）。 |
| `enableLocalFiles` | `true` | 启用路径来源，仍受 `allowedLocalRoots` 限制。 |
| `enableRemoteUrls` | `true` | 启用 HTTP(S) URL 来源。 |
| `allowedLocalRoots` | `[]` | 模型可读取的明确目录；空数组拒绝全部本地文件。 |
| `allowPrivateUrls` | `false` | 允许 localhost/私网 URL；只应在受控部署中启用。 |
| `defaultOcr` | `true` | Docling OCR 默认值。 |
| `defaultTableMode` | `accurate` | 表格提取模式：`fast` 或 `accurate`。 |
| `defaultOutputFormat` | `md` | `md`、`text` 或 `json`。 |
| `maxOutputChars` | `32000` | 返回给模型的最大解析文本长度。 |
| `debug` | `false` | 只记录请求元数据，绝不记录 API key 或文档内容。 |

无效配置会在 Cordis 加载插件时失败。

## 安全性

`dsh-docling` 会将模型提供的输入视为不可信数据。

- 本地路径会解析为 realpath，并与每个真实允许根目录比较。这会阻止 `..` 路径遍历
  与符号链接逃逸。`C:\` 和 `/` 等文件系统根目录不能作为配置。
- 远程文档仅可使用 `http:` 或 `https:`。在交给 Docling 前，会拒绝 localhost、回环、
  链路本地、私有 LAN、共享地址与其他非公网地址，并检查 DNS 解析结果。
- Docling Serve 负责最后的下载。请为其部署出口网络控制，同样阻止私网和云元数据服务：
  公网 URL 可能在插件预检后发生重定向或 DNS 重绑定。
- 上传前会对文件执行 stat；超出大小限制的文件不会发送。
- 输出有上限，并报告截断、原始字符数与实际返回字符数。限制器优先保留 Markdown
  章节边界，且不会截断 Unicode 代理对。

配置的 Docling Serve `baseUrl` 是由运维者控制的独立信任边界；它可以是私网地址。
`allowPrivateUrls` 仅控制让 Docling 下载的文档 URL。

## 开发

需要当前 DSH 支持的 Node 版本：`^22.19.0 || >=24`。

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

测试包含纯单元测试、进程内 HTTP mock 集成测试，以及真实 Cordis + DSH
`ToolRuntime` 的注册生命周期测试。真实 Docling 集成测试仅在提供服务时运行：

```bash
DOCLING_BASE_URL=http://127.0.0.1:5001 pnpm test:integration
```

PowerShell：

```powershell
$env:DOCLING_BASE_URL = 'http://127.0.0.1:5001'
pnpm test:integration
```

发布前，请检查准确的 npm 产物：

```bash
pnpm pack
tar -tf dsh-docling-0.1.0.tgz
```

## 路线图

- [ ] 上游 API 稳定后支持原生通用 Harness 附件
- [ ] 文档分块导航
- [ ] 可选文档缓存
- [ ] 图片和表格产物

## 许可与上游项目

本项目采用 MIT 许可证。DeepSeek Harness 与 Docling 也是独立的 MIT 开源项目。
`dsh-docling` 是独立的社区集成，不会打包、fork 或修改它们。
