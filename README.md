# Melora · 拾律

*From a hum to a melody.*

基于浏览器的原创旋律编辑器，第一阶段 MVP。

浏览器内完成 **原创哼唱 → Basic Pitch 识别 → Piano Roll 人工校正 → A/B 试听 → 人工确认锁定**。FastAPI 同时提供 API 和 React 静态页面，默认端口 **7865**。不加载、调用或运行 ACE-Step / YuE2。

## 启动

```bash
git clone https://github.com/zacliuntu/melora.git
cd melora
bash scripts/setup.sh   # 首次安装；已安装时无需重复执行
bash scripts/run.sh
```

访问 `http://服务器IP:7865`；在服务器本机可访问 `http://127.0.0.1:7865`。API 文档在 `/docs`。启动脚本使用单个 Uvicorn 进程，后台串行 CPU worker 执行 Basic Pitch，不占用编曲 GPU。

要求：Linux、FFmpeg、Node.js 20+、npm；安装脚本通过 uv 下载隔离的 Python 3.10。Basic Pitch 0.4.0 使用发行包自带模型及 TFLite CPU 运行时。模型首次运行会有预热时间。Python 与 npm 依赖分别锁定在 `requirements.lock.txt` 和 `frontend/package-lock.json`。

环境变量：`MELODY_PORT`（7865）、`MELODY_HOST`（0.0.0.0）、`MELODY_DATA_DIR`（本目录下 `data/`）。默认面向可信局域网；MVP 无多用户账户体系。需公网使用时，在现有认证反向代理后部署。


## 使用

1. 点击「导入原创哼唱」或将音频拖入欢迎页。支持 FFmpeg 可解码的 WAV、MP3、M4A、FLAC、OGG、WEBM；最多 100 MB / 5 分钟。保留原始上传件和 SHA-256，生成与原音频时间零点一致的单声道 WAV 供波形和 A/B 使用。
2. 识别完成后，波形、时间尺、音符使用同一个秒级坐标系。时间和音高均可缩放，横向/纵向滚动查看整个工程。
3. 拖动音符中心改变音高和起始时间；拖动左/右端改变起点/终点。双击空白新增音符，或选择「画音符」后单击。空白拖动框选多个音符，Shift 增减选择；选中的音符可整体拖动或伸缩。
4. 删除按钮 / Delete 删除，Ctrl/Cmd+Z 撤销，Ctrl/Cmd+Shift+Z 或 Ctrl+Y 重做。一次拖动对应一次撤销；当前浏览器会话保留最近 100 次操作，持久历史版本可跨刷新恢复。默认 50ms 吸附可关闭。
5. 在时间尺或波形拖动框选试听区间；播放、循环和 A/B 均遵循该区间。A 播放解码后的原唱，B 通过 Tone.js 实时合成编辑后的 MIDI 音符。切换 A/B 会从所选区间的同一起点重新播放。跨区间边界音符按区间裁切。播放由用户点击解锁 Web Audio，浏览器输出电平可确认实际音频信号。
6. 修改后约 650ms 自动保存；离线时保留浏览器本机草稿，并在关闭未保存页面时提示。保存失败可点击「保存」重试。版本历史恢复会创建新版本。服务器修订号阻止多个窗口互相覆盖，冲突时可下载本地 JSON 草稿再载入服务器版本；载入前还会保留一份本机备份。
7. 逐句试听后点击「确认主旋律并锁定」，勾选人工确认。服务端先校验当前修订号，再生成导出并持久化锁定；失败不锁定。确认后仍可试听，但不能改音符、恢复版本、重新识别或覆盖主旋律。

## 数据与确认保证

```text
data/
  editor.sqlite3           # 工程、每次保存快照、不可变导出 BLOB
  <project-id>/
    original               # 原始上传文件，原内容保留
    audio.wav              # 与原始时间轴一致的 22050 Hz 单声道音频
    transcription.mid      # Basic Pitch 初次识别 MIDI，待人工校正
    master/                # 只有人工确认后创建
      master_melody.mid
      master_melody.musicxml
      manifest.json        # 源文件和导出 SHA-256、确认版本、确认时间
```

确认产物文件权限为 `0444`，数据库触发器拒绝修改已确认工程及导出 BLOB；API 对锁定工程的写入返回 `423`。导出下载以数据库 BLOB 为准并校验 SHA-256，文件目录是供后续阶段使用的只读镜像。该只读约束针对应用和普通误操作，服务器管理员仍有文件系统管理权限。

MIDI 保留秒级时间，9600 ticks/quarter；MusicXML 使用显式 BPM、4/4 表示及每四分音符 10080 divisions，保留休止、重叠声部和跨小节延音线。不会将人工编辑后的时值强制吸附到传统八分音符；这是可交换的精细时间乐谱，正式出版用的节拍、调号和排版仍需后续整理。制谱速度只改变节拍表达，不拉伸原唱或音符时间。Basic Pitch 结果可能有泛音、滑音和多余音符，须人工审核。

`GET /api/projects/{id}/handoff` 在人工确认前返回 `409`。`POST /api/projects/{id}/arrange` 确认前返回 `409`，确认后仍返回 `501`，明确表示本阶段未启用编曲。确认不会触发任何音乐生成模型。

服务器重启后，SQLite 恢复工程及版本；中断的识别任务标为失败并可重试。单 worker 串行推理避免模型重复加载。备份时应停止服务后复制整个 `data/`（含 SQLite 及源音频），或使用 SQLite 在线备份 API。

## 验证

```bash
bash scripts/test.sh
```

测试要求可用 Chrome，默认 `/opt/google/chrome/chrome`，可用 `CHROME_PATH` 覆盖。浏览器测试在独立临时数据目录、端口 17865 运行，不确认用户原始作品；测试生成四音合成素材并运行真实 Basic Pitch，之后以已知音符校验拖动几何。测试覆盖编辑、伸缩、框选、撤销重做、保存恢复、区间播放停止、循环、实际音频电平、A/B、人工确认及后端不可变约束。报告和截图在 `frontend/playwright-report/` 与 `frontend/test-results/`。

开发：后端运行 7865，另开终端 `cd frontend && npm run dev`；Vite 将 `/api` 代理到 7865。生产环境必须先 `npm run build`，再启动 FastAPI。

参考：[Spotify Basic Pitch 官方文档](https://github.com/spotify/basic-pitch#readme)。

## 本次验收记录（2026-10-26）

- 生产构建成功；5 项后端测试通过；3 项真实 Chrome / Playwright 闭环测试通过，浏览器测试无 JavaScript 异常。
- MIDI 与 MusicXML 使用独立解析器读回验证音高、起止时间、重叠与延音线；导出文件权限与哈希验证通过。
- 依赖兼容修复：`resampy 0.4.2` 依赖 `pkg_resources`，因此锁定 `setuptools==80.9.0`；使用 NumPy 1.26.4 与 TFLite 2.14.0。模型实际推理已经通过。

仓库仅包含源码、依赖锁文件、启动脚本与测试。用户音频、工程数据库、模型运行环境和生成产物保存在本机，不纳入版本控制。
